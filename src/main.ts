// modelwatch's scheduled run (action.yml runs it from a private runner repo). As a GitHub App, for each repo:
//  - With .github/modelwatch.yml: plans the models it lists. If any should move, the agent makes the change in a
//    fresh clone, modelwatch checks the diff and updates the registry, and the App opens (or refreshes) one PR,
//    which the repo's own CI checks. Models modelwatch can't plan are listed in that PR and fail the job.
//  - Without one: once, the agent drafts a registry and the App opens a "Configure modelwatch" PR.
//
//   node src/main.ts --list              print the repos to check, as JSON (to GITHUB_OUTPUT `repos` in Actions)
//   node src/main.ts [--dry-run]         check them, as the App; secrets from MODELWATCH_SECRETS
//   node src/main.ts --plan [--dir DIR]  plan a local checkout; no keys needed
//
// The runner workflow lists the repos, then checks each in its own job, so an agent never shares a machine
// with another repo's checkout.
//
// MODELWATCH_SECRETS names a JSON file, written by action.yml and deleted here once read, so the secrets are
// never in an environment the agent could read: {app_id, app_private_key, openrouter_api_key,
// anthropic_api_key?, openai_api_key?, gemini_api_key?}. Also read: MODELWATCH_REPOS (only these
// repos, comma-separated), MODELWATCH_AGENT_MODEL (override), MODELWATCH_TIMEOUT_MINUTES (per agent run, default 20).
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { agentModel, agentStats, runAgent } from "./agent.ts";
import { BUMP_BRANCH, MAX_ATTEMPTS, buildPrompt, bumpsOf, prBody, prMarkers, updateRegistry, verifyDiff } from "./bump.ts";
import { CONFIGURE_BRANCH, configureBody, configurePrompt } from "./configure.ts";
import { git, listChanges, showAt } from "./git.ts";
import { App, api, commitFiles, type Repo } from "./github.ts";
import { Catalog, fetchModels, fetchProviderModels } from "./models.ts";
import { decline, planRepo, renderPlan, revise, type Plan } from "./plan.ts";
import { REGISTRY, REPO_URL, findUses, loadLanes, loadRegistry, parseRegistry, type Registry } from "./registry.ts";

type Ctx = {
  bot: { name: string; email: string };
  catalog: Catalog;
  apiKey: string;
  dry: boolean;
  timeoutMinutes: number;
};

function summary(md: string) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}

/** Lint errors and models modelwatch can't plan: the registry needs fixing. */
const brokenModels = (plan: Plan) => [...plan.errors, ...plan.models.filter((m) => m.status === "error").map((m) => `${m.id}: ${m.notes.at(-1)}`)];
/** brokenModels, plus models the checkout in `dir` doesn't use. */
const registryProblems = (dir: string, r: Registry, plan: Plan) =>
  [...brokenModels(plan), ...r.models.filter((m) => !findUses(dir, r, m.id).length).map((m) => `${m.id}: not found in the repo`)];

/**
 * A fresh shallow clone, and the commit it's at. The token is only in this one git command, before any agent
 * runs, and isn't left in the clone's config.
 */
function clone(repo: Repo, token: string): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "mw-repo-"));
  git(dir, ["clone", "-q", "--depth", "1", "--branch", repo.default_branch, `https://x-access-token:${token}@github.com/${repo.full_name}.git`, "."]);
  git(dir, ["remote", "set-url", "origin", `https://github.com/${repo.full_name}.git`]);
  return { dir, base: git(dir, ["rev-parse", "HEAD"]) };
}

const openPr = (repo: Repo, token: string, pr: { title: string; body: string; head: string; draft: boolean }) =>
  api(token, `repos/${repo.full_name}/pulls`, { method: "POST", body: { ...pr, base: repo.default_branch } });

/** Whether anyone but modelwatch has pushed to `branch` (commits made with git or through the API). */
async function othersPushed(ctx: Ctx, repo: Repo, token: string, branch: string): Promise<boolean> {
  const cmp = await api(token, `repos/${repo.full_name}/compare/${encodeURIComponent(repo.default_branch)}...${encodeURIComponent(branch)}`);
  return !!cmp?.commits?.some((c: any) => c.author?.login !== ctx.bot.name && c.commit.author.email !== ctx.bot.email);
}

/**
 * Problems that need a human to fix the registry. They're in the bump PR when there is one; either way they fail
 * this job, so the runner's owner hears about them.
 */
function needsAttention(repo: Repo, problems: string[]) {
  for (const p of problems) console.log(`::error title=${repo.full_name}: fix ${REGISTRY}::${p}`);
  if (problems.length) process.exitCode = 1;
}

async function bumpRepo(ctx: Ctx, repo: Repo, token: string, text: string): Promise<string> {
  let r!: Registry, plan: Plan;
  try {
    r = parseRegistry(text);
    plan = planRepo(r, loadLanes(r), ctx.catalog);
  } catch (e) {
    plan = { hash: "", errors: [`can't read it: ${(e as Error).message}`], models: [] };
  }
  if (plan.errors.length) {
    console.log(renderPlan(plan));
    throw new Error(`fix ${REGISTRY}: ${plan.errors.join("; ")}`);
  }

  // Closing a bump PR without merging declines its moves, as Dependabot does; a newer target is proposed again.
  const owner = repo.full_name.split("/")[0];
  const prs: any[] = (await api(token, `repos/${repo.full_name}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${owner}:${BUMP_BRANCH}`)}`)) ?? [];
  const declined = new Map<string, number>();
  for (const pr of prs) {
    const mk = prMarkers(pr.body);
    if (pr.state === "closed" && !pr.merged_at && !mk.superseded) for (const mv of mk.moves) if (!declined.has(mv)) declined.set(mv, pr.number);
  }
  plan = decline(plan, declined);
  const existing = prs.find((pr) => pr.state === "open");

  const { dir, base } = clone(repo, token);
  try {
    const uses = new Map(bumpsOf(plan).map((m) => [m.id, findUses(dir, r, m.id)]));
    plan = revise(plan, (m) => m.status === "bump" && !uses.get(m.id)!.length
      ? { ...m, status: "error", notes: [...m.notes, "the repo doesn't use it any more: remove it from the registry"] }
      : m);
    console.log(renderPlan(plan));
    const broken = brokenModels(plan);
    needsAttention(repo, broken);
    const attention = broken.length ? `; ⚠️ fix ${REGISTRY}: ${broken.join("; ")}` : "";

    const bumps = bumpsOf(plan);
    if (!bumps.length) {
      // An open bump PR nothing needs any more (say, the models were moved by hand): close it, unless someone's
      // working on it or this run couldn't plan everything.
      if (existing && !broken.length && !ctx.dry && !(await othersPushed(ctx, repo, token, BUMP_BRANCH))) {
        await api(token, `repos/${repo.full_name}/issues/${existing.number}/comments`, { method: "POST", body: { body: "Closing: every model in the registry is current now." } });
        await api(token, `repos/${repo.full_name}/pulls/${existing.number}`, { method: "PATCH", body: { state: "closed", body: `${existing.body ?? ""}\n<!-- modelwatch-superseded -->` } });
        return `✅ up to date; closed #${existing.number}`;
      }
      return `✅ up to date${attention}`;
    }

    // Redo an open PR with this same plan only if its run had problems, a few times at most.
    let attempt = 1;
    if (existing) {
      const mk = prMarkers(existing.body);
      if (mk.hash === plan.hash) {
        if (!mk.attempt) return `⏭️ #${existing.number} already has this bump${attention}`;
        if (mk.attempt >= MAX_ATTEMPTS) return `⏭️ #${existing.number} has this bump; ${mk.attempt} runs had problems, so it's left for a human${attention}`;
        attempt = mk.attempt + 1;
      }
      if (await othersPushed(ctx, repo, token, BUMP_BRANCH)) return `⚠️ #${existing.number} has commits from someone else; left alone${attention}`;
    }

    const model = agentModel(r, ctx.catalog);
    const run = await runAgent({ prompt: buildPrompt(r, plan, ctx.catalog, repo.full_name, uses), dir, model, apiKey: ctx.apiKey, timeoutMinutes: ctx.timeoutMinutes });
    const stats = agentStats(model, run);
    console.log(stats);
    const changes = listChanges(dir, base);
    if (!changes.length) throw new Error(`the agent changed nothing. ${run.error ?? ""}`);
    const problems = verifyDiff(dir, base, r, plan, changes);
    if (!run.ok) problems.push(`the agent didn't finish cleanly: ${run.error ?? "no final message"}`);
    const leftovers = new Map(bumps.map((m) => [m.id, findUses(dir, r, m.id)]));
    // modelwatch updates the registry itself, starting from the committed one whatever the agent did to it.
    mkdirSync(dirname(join(dir, REGISTRY)), { recursive: true });
    writeFileSync(join(dir, REGISTRY), showAt(dir, base, REGISTRY));
    updateRegistry(dir, plan);
    const body = prBody(r, plan, run.final || "### Changes beyond the ID swap\n(the agent wrote no summary)", problems, leftovers, stats, attempt);
    const title = `Bump models: ${bumps.map((m) => `${m.id} → ${m.target}`).join(", ")}`.slice(0, 200);
    if (ctx.dry) {
      summary(`<details><summary>${repo.full_name}: ${title}</summary>\n\n${body}\n</details>`);
      return `🔍 would open: ${title}${attention}`;
    }
    await commitFiles(token, repo.full_name, {
      branch: BUMP_BRANCH, parent: base, changes: listChanges(dir, base),
      message: `${title}\n\nOpened by modelwatch (${REPO_URL}); edited by Pi running ${model} via OpenRouter.`,
    });
    if (existing) {
      await api(token, `repos/${repo.full_name}/pulls/${existing.number}`, { method: "PATCH", body: { title, body } });
      return `⬆️ updated ${existing.html_url}${attention}`;
    }
    return `⬆️ opened ${(await openPr(repo, token, { title, body, head: BUMP_BRANCH, draft: problems.length > 0 })).html_url}${attention}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function configureRepo(ctx: Ctx, repo: Repo, token: string): Promise<string> {
  const owner = repo.full_name.split("/")[0];
  const asked = (await api(token, `repos/${repo.full_name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${CONFIGURE_BRANCH}`)}`))?.[0];
  if (asked) return `⏸️ not set up (#${asked.number} is ${asked.merged_at ? "merged, but the registry is gone" : asked.state})`;

  const { dir, base } = clone(repo, token);
  try {
    const model = agentModel({ models: [] }, ctx.catalog);
    const run = await runAgent({ prompt: configurePrompt(repo.full_name), dir, model, apiKey: ctx.apiKey, timeoutMinutes: ctx.timeoutMinutes });
    const stats = agentStats(model, run);
    console.log(stats);
    const path = join(dir, REGISTRY);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`the agent wrote no ${REGISTRY}. ${run.error ?? ""}`);
    // Only the registry goes in the PR. Put everything else back, so the checks below see the repo as it is.
    const text = readFileSync(path, "utf8");
    git(dir, ["reset", "-q", "--hard", base]);
    git(dir, ["clean", "-fdq"]);

    let r: Registry | null = null, plan: Plan | null = null;
    const problems: string[] = [];
    try {
      r = parseRegistry(text);
      plan = planRepo(r, loadLanes(r), ctx.catalog);
      problems.push(...registryProblems(dir, r, plan));
    } catch (e) {
      problems.push(`can't read it: ${(e as Error).message}`);
    }
    if (!run.ok) problems.push(`the agent didn't finish cleanly: ${run.error ?? "no final message"}`);
    const title = r && Array.isArray(r.models) && !r.models.length ? "Configure modelwatch (no model IDs found)" : "Configure modelwatch";
    const body = configureBody(r, plan, problems, run.final || "### What I found\n(the agent wrote no summary)", stats);
    if (ctx.dry) {
      summary(`<details><summary>${repo.full_name}: ${title}</summary>\n\n${body}\n\n\`\`\`yaml\n${text}\n\`\`\`\n</details>`);
      return `🔍 would open: ${title}`;
    }
    await commitFiles(token, repo.full_name, {
      branch: CONFIGURE_BRANCH, parent: base,
      changes: [{ path: REGISTRY, kind: "added", content: Buffer.from(text), mode: "100644" }],
      message: `${title}\n\nOpened by modelwatch (${REPO_URL}); drafted by Pi running ${model} via OpenRouter.`,
    });
    return `🆕 opened ${(await openPr(repo, token, { title, body, head: CONFIGURE_BRANCH, draft: problems.length > 0 })).html_url}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readSecrets(required: string[]): Record<string, string | undefined> {
  const path = process.env.MODELWATCH_SECRETS;
  if (!path) throw new Error("MODELWATCH_SECRETS is required; see action.yml");
  const s = JSON.parse(readFileSync(path, "utf8"));
  rmSync(path);
  for (const k of required) if (!s[k]) throw new Error(`secret ${k} is missing`);
  return s;
}

async function planLocal(dir: string) {
  const r = loadRegistry(dir);
  const { ANTHROPIC_API_KEY: anthropic, OPENAI_API_KEY: openai, GEMINI_API_KEY: gemini } = process.env;
  const catalog = new Catalog(await fetchModels(), await fetchProviderModels({ anthropic, openai, gemini }));
  const plan = planRepo(r, loadLanes(r), catalog);
  console.log(renderPlan(plan));
  const broken = registryProblems(dir, r, plan);
  for (const b of broken) console.log(`::error title=${REGISTRY}::${b}`);
  if (broken.length) process.exitCode = 1;
}

/** The repos to check: MODELWATCH_REPOS, or every repo the App is installed on; never archived ones or the runner. */
async function selectRepos(app: App): Promise<Repo[]> {
  const only = (process.env.MODELWATCH_REPOS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const repos: Repo[] = [];
  if (!only.length) repos.push(...await app.repos());
  for (const name of only) {
    const r = await app.repo(name);
    if (r) repos.push(r);
    else console.log(`::warning::${name}: the App isn't installed there`);
  }
  return repos.filter((r) => !r.archived && r.full_name !== process.env.GITHUB_REPOSITORY);
}

async function main() {
  const { values: o } = parseArgs({ options: { plan: { type: "boolean" }, dir: { type: "string" }, list: { type: "boolean" }, "dry-run": { type: "boolean" } } });
  if (o.plan) return planLocal(o.dir ?? process.cwd());

  const s = readSecrets(o.list ? ["app_id", "app_private_key"] : ["app_id", "app_private_key", "openrouter_api_key"]);
  const app = new App(s.app_id!, s.app_private_key!);
  const repos = await selectRepos(app);
  if (o.list) {
    const json = JSON.stringify(repos.map((r) => r.full_name));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `repos=${json}\n`);
    console.log(repos.length ? `Checking ${repos.length} repos: ${json}` : "No repos to check: install the App on some.");
    return;
  }
  if (!repos.length) return console.log("No repos to check: install the App on some.");

  const catalog = new Catalog(await fetchModels(), await fetchProviderModels({ anthropic: s.anthropic_api_key, openai: s.openai_api_key, gemini: s.gemini_api_key }));
  const ctx: Ctx = {
    bot: await app.identity(await app.token(repos[0])), catalog, apiKey: s.openrouter_api_key!, dry: !!o["dry-run"],
    timeoutMinutes: Number(process.env.MODELWATCH_TIMEOUT_MINUTES || 20),
  };

  const rows: string[] = [];
  let failed = 0;
  for (const repo of repos) {
    console.log(`::group::${repo.full_name}`);
    let result: string;
    try {
      const token = await app.token(repo);
      const text = await api(token, `repos/${repo.full_name}/contents/${REGISTRY}?ref=${encodeURIComponent(repo.default_branch)}`, { raw: true });
      result = text === null ? await configureRepo(ctx, repo, token) : await bumpRepo(ctx, repo, token, text);
    } catch (e) {
      failed++;
      result = `❌ ${(e as Error).message}`;
      console.log(`::error title=${repo.full_name}::${(e as Error).message}`);
    }
    console.log(result);
    console.log("::endgroup::");
    rows.push(`| ${repo.full_name} | ${result.replace(/\s+/g, " ").replace(/\|/g, "\\|")} |`);
  }
  summary(["### modelwatch", "", "| repo | result |", "|---|---|", ...rows].join("\n"));
  if (failed) process.exitCode = 1;
}

await main();
