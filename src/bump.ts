// A model bump in one repo: the agent's prompt, checks on its diff, the registry update, and the PR body.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Composer, CST, isMap, Parser, type YAMLSeq } from "yaml";
import { showAt, type Change } from "./git.ts";
import type { Catalog } from "./models.ts";
import { move, type ModelPlan, type Plan } from "./plan.ts";
import { DOCS_URL, REGISTRY, badge, footer, idPattern, isIgnored, type Registry } from "./registry.ts";

export const BUMP_BRANCH = "modelwatch/model-bump";
const price = (perToken?: string) => (perToken ? `$${(Number(perToken) * 1e6).toFixed(2)}/M` : "?");
export const bumpsOf = (plan: Plan) => plan.models.filter((m) => m.status === "bump");
const listed = (uses: string[], max = 30) => uses.slice(0, max).join(", ") + (uses.length > max ? `, and ${uses.length - max} more` : "");

/** `uses` maps each old ID to where the repo mentions it ("file:line"). */
export function buildPrompt(r: Registry, plan: Plan, catalog: Catalog, repo: string, uses: Map<string, string[]>): string {
  const lines = [
    `You are modelwatch's upgrade agent working in a checkout of ${repo}.`,
    "Your job: move the models below to their selected targets and update what must change with them.",
    "A repo's custom chain can deliberately select an older model or a different family. Follow the selected targets.",
    "A human reviews the PR, and the repo's CI runs on it. Keep the diff minimal and easy to review.",
    "",
    "## Models to move",
  ];
  for (const m of bumpsOf(plan)) {
    const next = catalog.byId.get(m.laneSlug!);
    lines.push(
      `### \`${m.id}\` -> \`${m.target}\``,
      next?.source ? `${next.name}, listed by the ${next.source} (not OpenRouter, so no price here).`
        : `${next?.name}; prompt ${price(next?.pricing?.prompt)}, completion ${price(next?.pricing?.completion)} (OpenRouter list price).`,
      `Mentioned at: ${listed(uses.get(m.id) ?? [])}`,
    );
  }
  const held = plan.models.filter((m) => m.status === "hold" || m.status === "declined");
  if (held.length) lines.push("", "## Held models: don't change these", ...held.map((m) => `- \`${m.id}\`: ${m.notes[0]}`));
  lines.push("", "## Never modify", `- ${REGISTRY} (modelwatch updates it)`, ...(r.ignore ?? []).map((g) => `- ${g}`));
  if (r.notes) lines.push("", "## Notes from the repo", r.notes.trim());
  lines.push(
    "",
    "## Rules",
    "- Replace every live use of each old ID: code, config, env examples, workflow files, tests that assert it, and a " +
      "display name next to it. Leave mentions that aren't live uses (docs, changelogs, catalogs or price tables that list " +
      "many models, fixtures that use a model as sample data, migrations) and say which you left.",
    "- Where the repo keeps per-model lists (pricing, allowlists, per-model settings), add the new model and keep the old one.",
    "- Don't rewrite prompts, refactor, or change behavior beyond what the new model needs to accept the same requests. When " +
      "a request needs model-specific handling, key it on something that survives the next bump (a family prefix, a config " +
      "flag), not a hardcoded list of today's IDs.",
    "- CI runs on the PR, so don't install dependencies or run the full test suite. A quick targeted check is fine.",
    "- Don't run paid evals, deploys, migrations, or anything that needs secrets. Don't commit, push, or open PRs; modelwatch does that.",
    "",
    "## Your final message",
    "It becomes part of the PR description. Write markdown with exactly these sections:",
    "### Changes beyond the ID swap",
    "(bullets: files and why; 'None' if there were none)",
    "### For the reviewer",
    "(bullets: old IDs you left and why, risks, behavior that might shift with the new model, anything you weren't sure about)",
  );
  return lines.join("\n");
}

/** Problems in the agent's changes (from listChanges against commit `base`) that should make the PR a draft. */
export function verifyDiff(dir: string, base: string, r: Registry, plan: Plan, changes: Change[]): string[] {
  const problems: string[] = [];
  // Lines that are new in each file, new files included.
  const added = changes.filter((c) => c.content).map((c) => {
    const old = new Set(showAt(dir, base, c.path).split("\n"));
    return c.content!.toString("utf8").split("\n").filter((l) => !old.has(l)).join("\n");
  }).join("\n");
  for (const m of bumpsOf(plan)) if (!idPattern(m.target!).test(added)) problems.push(`nothing in the diff uses \`${m.target}\` (replacing \`${m.id}\`)`);
  for (const c of changes) if (isIgnored(r, c.path)) problems.push(`${c.path} is in an ignored path`);
  const created = changes.filter((c) => c.kind === "added" && !isIgnored(r, c.path)).map((c) => `\`${c.path}\``);
  if (created.length) problems.push(`the agent added new files; check they belong: ${listed(created, 10)}`);
  return problems;
}

/**
 * Points the bumped models at their new IDs, editing only those entries so the rest of the file stays byte for
 * byte. Two models that moved to the same ID become one entry. Explicit lane assignments are kept so the
 * repo continues following the user's chosen lane after each upgrade. A one-line list (`models: [a, b]`) is
 * edited as YAML and the file re-rendered, since removing an entry there means removing a comma too.
 */
export function updateRegistry(dir: string, plan: Plan): void {
  const path = join(dir, REGISTRY);
  const tokens = [...new Parser().parse(readFileSync(path, "utf8"))];
  const [doc] = new Composer({ keepSourceTokens: true }).compose(tokens);
  const models = doc.get("models") as YAMLSeq<any>;
  const block = models.srcToken?.type === "block-seq";
  const seq = models.srcToken as CST.BlockSequence;
  const idOf = (n: any): string => (isMap(n) ? n.get("id") as string : n.value);
  const targets = new Map(bumpsOf(plan).map((m) => [m.id, m.target!]));
  const entries = models.items.map((n, i) => ({ n, i, id: idOf(n), target: targets.get(idOf(n)) ?? idOf(n) }));
  // Decide duplicates from final IDs, before editing. Otherwise A -> B can disappear while B -> C moves on.
  // Prefer an entry already at the target, preserving any hold, eval or other settings it has.
  const keep = new Map(entries.filter((e) => e.id === e.target).map((e) => [e.target, e.i]));
  for (const e of entries) if (!keep.has(e.target)) keep.set(e.target, e.i);
  for (const { n, i, id, target } of entries.reverse()) {
    if (keep.get(target) !== i) {
      models.items.splice(i, 1);
      if (block) seq.items.splice(i, 1);
    } else if (id === target) {
      continue;
    } else if (!isMap(n)) {
      if (block) CST.setScalarValue(n.srcToken, target);
      n.value = target;
    } else {
      if (block && n.items.length === 1) CST.setScalarValue(seq.items[i].value!, target); // just the id is left
      else if (block) CST.setScalarValue((n.items.find((p: any) => p.key.value === "id") as any).value.srcToken, target);
      n.set("id", target);
    }
  }
  writeFileSync(path, block ? tokens.map((t) => CST.stringify(t)).join("") : doc.toString());
}

/**
 * `leftovers` maps each old ID to where the repo still mentions it after the agent's changes. `attempt` counts
 * runs of this same plan that ended with problems; modelwatch retries those, up to MAX_ATTEMPTS.
 */
export function prBody(r: Registry, plan: Plan, agentNotes: string, problems: string[], leftovers: Map<string, string[]>, stats = "", attempt = 1): string {
  const bumps = bumpsOf(plan);
  // With several bumps, the table above says which old ID became which new one.
  const fill = (s: string, ms: ModelPlan[]) => ms.length === 1
    ? s.trim().replaceAll("<old>", ms[0].id).replaceAll("<new>", ms[0].target!)
    : s.trim().replaceAll("<old>", "the old ID").replaceAll("<new>", "the new ID");
  const out = [
    badge("model bump"),
    "",
    "| from | to | notes |",
    "|---|---|---|",
    ...bumps.map((m) => `| \`${m.id}\` | \`${m.target}\` | ${m.notes.join("; ")} |`),
    "",
  ];
  if (problems.length) out.push("> [!WARNING]", "> Draft: modelwatch's checks found problems.", ...problems.map((p) => `> - ${p}`), "");
  const evals = bumps.filter((m) => m.eval);
  if (evals.length) out.push("### Before merging: run evals", ...evals.map((m) => `- [ ] \`${fill(m.eval!, [m])}\``), "");
  if (r.after_merge?.length) out.push("### After merging", ...r.after_merge.map((s) => `- [ ] ${fill(s, bumps)}`), "");
  const broken = plan.models.filter((m) => m.status === "error");
  if (broken.length) {
    out.push(`### Fix in \`${REGISTRY}\``, `modelwatch can't upgrade these until the registry is fixed ([format](${DOCS_URL})); \`hold:\` a model to stop watching it.`,
      ...broken.map((m) => `- \`${m.id}\`: ${m.notes.at(-1)}`), "");
  }
  out.push(agentNotes.trim(), "");
  const left = bumps.filter((m) => leftovers.get(m.id)?.length);
  if (left.length) {
    out.push("<details><summary>Old IDs still in the repo</summary>", "", ...left.map((m) => `- \`${m.id}\`: ${listed(leftovers.get(m.id)!)}`), "", "</details>", "");
  }
  const other = plan.models.filter((m) => m.status === "hold" || m.status === "declined");
  if (other.length) out.push("<details><summary>Models not changed</summary>", "", ...other.map((m) => `- \`${m.id}\` (${m.status}): ${m.notes.join("; ")}`), "", "</details>", "");
  out.push(footer(stats), "");
  // Machine-readable. plan and attempt: whether to redo this PR. moves (as the repo spells them): what closing
  // it declines. bumps: for post-merge automation in the repo, as `provider/model` IDs whatever the repo's
  // spelling; a model OpenRouter no longer lists is left out.
  const pairs = new Set(bumps.filter((m) => m.currentSlug).map((m) => `${m.currentSlug}=${m.laneSlug}`));
  out.push(`<!-- modelwatch-plan: ${plan.hash} -->`);
  if (problems.length) out.push(`<!-- modelwatch-attempt: ${attempt} -->`);
  out.push(`<!-- modelwatch-moves: ${bumps.map(move).join(",")} -->`, `<!-- modelwatch-bumps: ${[...pairs].join(",")} -->`);
  return out.join("\n");
}

/** How many runs of the same plan modelwatch makes when each ends with problems. */
export const MAX_ATTEMPTS = 3;

/** Reads what prBody wrote into a PR's body. */
export function prMarkers(body: string | null | undefined) {
  const get = (k: string) => body?.match(new RegExp(`<!-- modelwatch-${k}: ?(.*?) -->`))?.[1];
  return {
    hash: get("plan"),
    attempt: Number(get("attempt") ?? 0), // 0: the run had no problems
    moves: (get("moves") ?? "").split(",").filter(Boolean),
    superseded: !!body?.includes("<!-- modelwatch-superseded -->"),
  };
}
