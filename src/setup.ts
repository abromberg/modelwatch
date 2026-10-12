// Setup and upgrades. Needs the GitHub CLI, logged in.
//
//   node src/setup.ts [--org ORG]            one-time setup
//   node src/setup.ts --upgrade [--org ORG]  move the runner to a newer modelwatch
//
// Setup creates your private runner repo with the workflow, creates your modelwatch GitHub App (one click in the
// browser), and stores the App's credentials as secrets on the runner repo. Set OPENROUTER_API_KEY in the
// environment to store it too; otherwise add it afterwards.
//
// The runner's workflow pins modelwatch to one commit, so code from modelwatch's repo (which can read your App's
// key) only reaches your runner when you run --upgrade. That shows what changed and asks before it moves the pin.
//
// --org      the runner repo and App belong to this organization instead of your account (you must be an owner)
// --from     the modelwatch repo to run, as owner/name: default this checkout's origin (so a fork runs itself),
//            else abromberg/modelwatch. --upgrade defaults to the repo the runner is pinned to now.
// --ref      the tag, branch or commit to pin: default the latest release, else the default branch
// --yes      upgrade without asking
// --new-app  create another App even though the runner repo already has one's credentials
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { HOME } from "./registry.ts";

function gh(args: string[], input?: string): string {
  const r = spawnSync("gh", args, { input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout.trim();
}
const ghOk = (args: string[]) => spawnSync("gh", args, { stdio: "ignore" }).status === 0;

const { values: o } = parseArgs({
  options: {
    org: { type: "string" }, upgrade: { type: "boolean" }, from: { type: "string" }, ref: { type: "string" },
    yes: { type: "boolean" }, "new-app": { type: "boolean" },
  },
});
const owner = o.org ?? gh(["api", "user", "--jq", ".login"]);
const runner = `${owner}/modelwatch-runner`;
const WORKFLOW = ".github/workflows/modelwatch.yml";
const PIN = /^([ \t]*(?:-[ \t]+)?uses:[ \t]*)([\w.-]+\/[\w.-]+)@(\S+)(.*)$/gm;

/** This checkout's GitHub repo, from its origin remote. */
function checkoutRepo(): string | undefined {
  const url = spawnSync("git", ["-C", HOME, "remote", "get-url", "origin"], { encoding: "utf8" }).stdout?.trim() ?? "";
  return url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
}

/** The commit to pin, and a label for it: `ref`, else the latest release, else the default branch. */
function resolvePin(source: string, ref?: string): { sha: string; label: string } {
  let label = ref;
  if (!label) {
    const release = spawnSync("gh", ["api", `repos/${source}/releases/latest`, "--jq", ".tag_name"], { encoding: "utf8" });
    label = release.status === 0 && release.stdout.trim() ? release.stdout.trim() : gh(["api", `repos/${source}`, "--jq", ".default_branch"]);
  }
  return { sha: gh(["api", `repos/${source}/commits/${encodeURIComponent(label)}`, "--jq", ".sha"]), label };
}

/** The runner workflow from `source` at `sha`, with every `uses:` of modelwatch pinned to that commit. */
function pinnedWorkflow(source: string, pin: { sha: string; label: string }): string {
  const text = gh(["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${source}/contents/runner/modelwatch.yml?ref=${pin.sha}`]) + "\n";
  return text.replace(PIN, (_, pre) => `${pre}${source}@${pin.sha} # ${pin.label}`);
}

/** Writes the runner's workflow file. `sha` is the current file's, when replacing it. */
function putWorkflow(message: string, text: string, sha?: string) {
  try {
    gh(["api", "-X", "PUT", `repos/${runner}/contents/${WORKFLOW}`, "--input", "-"], JSON.stringify({ message, content: Buffer.from(text).toString("base64"), sha }));
  } catch (e) {
    // GitHub answers 404 when the token can't edit workflow files.
    throw new Error(`${(e as Error).message}\nChanging a workflow file needs the gh "workflow" scope: run \`gh auth refresh -s workflow\` and try again.`);
  }
}

if (o.upgrade) await upgrade();
else await setup();

async function upgrade() {
  const file = spawnSync("gh", ["api", `repos/${runner}/contents/${WORKFLOW}`], { encoding: "utf8" });
  if (file.status !== 0) throw new Error(`${runner} has no ${WORKFLOW}; run setup first (without --upgrade)`);
  const { sha: fileSha, content } = JSON.parse(file.stdout);
  const current = Buffer.from(content, "base64").toString("utf8");
  const [, , pinnedRepo, pinnedRef] = [...current.matchAll(PIN)][0] ?? [];
  const source = o.from ?? pinnedRepo ?? checkoutRepo() ?? "abromberg/modelwatch";
  const pin = resolvePin(source, o.ref);
  if (pinnedRepo === source && pinnedRef === pin.sha) return console.log(`${runner} already runs ${source}@${pin.sha} (${pin.label}).`);

  // Keep the runner's own schedule; the rest of the file comes from the new version.
  let next = pinnedWorkflow(source, pin);
  const crons = current.match(/^[ \t]*- cron: .*$/gm);
  if (crons) next = next.replace(/^[ \t]*- cron: .*$/m, crons.join("\n"));

  console.log(`\n${runner} runs ${pinnedRepo ?? "?"}@${pinnedRef ?? "?"}. Upgrading to ${source}@${pin.sha} (${pin.label}).`);
  if (pinnedRepo === source && /^[0-9a-f]{40}$/.test(pinnedRef ?? "")) {
    console.log(`What changed in modelwatch: https://github.com/${source}/compare/${pinnedRef}...${pin.sha}`);
  } else {
    console.log(`modelwatch's history: https://github.com/${source}/commits/${pin.sha}`);
  }
  const dir = mkdtempSync(join(tmpdir(), "mw-upgrade-"));
  try {
    writeFileSync(join(dir, "current.yml"), current);
    writeFileSync(join(dir, "new.yml"), next);
    console.log(`\nChanges to ${WORKFLOW}:`);
    spawnSync("git", ["diff", "--no-index", "--color", "current.yml", "new.yml"], { cwd: dir, stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (!o.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`\nUpdate ${runner}? [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) return console.log("Left as it was.");
  }
  putWorkflow(`Upgrade modelwatch to ${pin.label} (${pin.sha.slice(0, 7)})`, next, fileSha);
  console.log(`Updated ${runner}. Try it:  gh workflow run modelwatch.yml -R ${runner} -f dry-run=true`);
}

async function setup() {
  // 1. The runner repo. Private, because its run logs include output from the repos modelwatch works on.
  if (!ghOk(["repo", "view", runner])) {
    gh(["repo", "create", runner, "--private", "--description", "Runs modelwatch (https://github.com/abromberg/modelwatch)"]);
    console.log(`Created ${runner} (private).`);
  }
  if (ghOk(["api", `repos/${runner}/contents/${WORKFLOW}`])) {
    console.log(`${runner} already has ${WORKFLOW}. To move it to a newer modelwatch: node src/setup.ts --upgrade${o.org ? ` --org ${o.org}` : ""}`);
  } else {
    const source = o.from ?? checkoutRepo() ?? "abromberg/modelwatch";
    const pin = resolvePin(source, o.ref);
    putWorkflow(`Add the modelwatch workflow (${pin.label})`, pinnedWorkflow(source, pin));
    console.log(`Added ${WORKFLOW} to ${runner}, running ${source}@${pin.sha.slice(0, 7)} (${pin.label}).`);
  }

  // 2. The App, unless the runner already has one's credentials (say, setup is being run again).
  const secrets = gh(["secret", "list", "-R", runner, "--json", "name", "--jq", ".[].name"]).split("\n");
  let installUrl = "your App's page (Settings → Developer settings → GitHub Apps → your modelwatch App → Install App)";
  if (secrets.includes("MODELWATCH_APP_ID") && !o["new-app"]) {
    console.log(`${runner} already has an App's credentials; keeping them (--new-app to create another App).`);
  } else {
    const app = await createApp();
    console.log(`Created the App ${app.slug} (${app.html_url}).`);
    gh(["secret", "set", "MODELWATCH_APP_ID", "-R", runner], String(app.id));
    gh(["secret", "set", "MODELWATCH_APP_PRIVATE_KEY", "-R", runner], app.pem);
    console.log(`Stored the App's credentials as secrets on ${runner}.`);
    installUrl = `${app.html_url}/installations/new`;
  }

  // 3. The OpenRouter key, if given.
  if (process.env.OPENROUTER_API_KEY) {
    gh(["secret", "set", "OPENROUTER_API_KEY", "-R", runner], process.env.OPENROUTER_API_KEY);
    console.log(`Stored your OpenRouter key as a secret on ${runner}.`);
  }
  const needsKey = !process.env.OPENROUTER_API_KEY && !secrets.includes("OPENROUTER_API_KEY");

  console.log(`
Next:
${needsKey ? `- Add your OpenRouter key:  gh secret set OPENROUTER_API_KEY -R ${runner}\n` : ""}\
- Optionally add ANTHROPIC_API_KEY, OPENAI_API_KEY and GEMINI_API_KEY the same way, to also check those
  providers' own model lists.
- Install the App on the repos to watch (or all of them): ${installUrl}
- Try it without opening PRs:  gh workflow run modelwatch.yml -R ${runner} -f dry-run=true
  Repos without a registry get a "Configure modelwatch" PR; it runs weekly after that.
- Later, to move to a newer modelwatch:  node src/setup.ts --upgrade${o.org ? ` --org ${o.org}` : ""}`);
}

/**
 * Creates the App from a manifest: GitHub shows a "Create GitHub App" page, then redirects back here with a code
 * that's exchanged for the App's ID and private key.
 */
async function createApp(): Promise<any> {
  const state = randomUUID();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const manifest = {
    name: `modelwatch-${owner}`.toLowerCase().slice(0, 34), // App names are global; GitHub lets you change it
    url: `https://github.com/${runner}`,
    hook_attributes: { url: `https://github.com/${runner}`, active: false }, // no webhooks: the runner polls
    redirect_url: `http://127.0.0.1:${port}/done`,
    public: false,
    default_permissions: { contents: "write", pull_requests: "write", workflows: "write", metadata: "read" },
    default_events: [],
  };
  const createAt = o.org ? `https://github.com/organizations/${o.org}/settings/apps/new` : "https://github.com/settings/apps/new";
  const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const minutes = 15;

  try {
    return await new Promise<any>((resolve, reject) => {
      setTimeout(() => reject(new Error(`no App was created within ${minutes} minutes; run setup again`)), minutes * 60_000).unref();
      server.on("request", async (req, res) => {
        const url = new URL(req.url!, `http://127.0.0.1:${port}`);
        if (url.pathname === "/") {
          res.setHeader("content-type", "text/html");
          return res.end(`<form method="post" action="${attr(`${createAt}?state=${state}`)}"><input type="hidden" name="manifest" value="${attr(JSON.stringify(manifest))}">` +
            `<p>Taking you to GitHub to create your modelwatch App…</p><button>Continue</button></form><script>document.forms[0].submit()</script>`);
        }
        if (url.pathname !== "/done" || url.searchParams.get("state") !== state) return res.end();
        try {
          const r = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, { method: "POST" });
          if (!r.ok) throw new Error(`creating the App: HTTP ${r.status} ${await r.text()}`);
          res.end("Your modelwatch App is created. Return to the terminal.");
          resolve(await r.json());
        } catch (e) {
          res.end(`Something went wrong: ${(e as Error).message}`);
          reject(e);
        }
      });
      const start = `http://127.0.0.1:${port}/`;
      console.log(`\nOpening ${start} to create your modelwatch App. Click "Create GitHub App" there.`);
      spawnSync(process.platform === "darwin" ? "open" : "xdg-open", [start], { stdio: "ignore" });
    });
  } finally {
    server.close();
  }
}
