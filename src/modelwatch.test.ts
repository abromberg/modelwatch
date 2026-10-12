import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentModel, agentStats, repoEnv } from "./agent.ts";
import { prBody, prMarkers, updateRegistry, verifyDiff } from "./bump.ts";
import { configureBody, configurePrompt } from "./configure.ts";
import { formatId, inferFormat } from "./format.ts";
import { listChanges } from "./git.ts";
import { commitFiles } from "./github.ts";
import { Catalog, newest, type OrModel } from "./models.ts";
import { decline, planModel, planRepo, type Plan } from "./plan.ts";
import { findUses, idPattern, isIgnored, lintRegistry, loadLanes, parseRegistry, type Registry } from "./registry.ts";
import { withZdr } from "./zdr.ts";

const m = (id: string, created: number, extra: Partial<OrModel> = {}): OrModel => ({ id, name: id, created, ...extra });
const catalog = new Catalog([
  m("anthropic/claude-sonnet-5", 100, { canonical_slug: "anthropic/claude-sonnet-5-20260301" }),
  m("anthropic/claude-sonnet-5.5", 200),
  m("~anthropic/claude-sonnet-latest", 200, { alias_target: { slug: "anthropic/claude-sonnet-5.5", name: "" } }),
  m("google/gemini-3.5-flash-lite", 100),
  m("google/gemini-3.6-flash-lite", 300),
  m("google/gemini-3.6-flash-lite:free", 400, { canonical_slug: "google/gemini-3.6-flash-lite" }),
  m("openai/text-embedding-3-small", 50),
  m("z-ai/glm-5.3-flash", 300, { pricing: { prompt: "0.000002", completion: "0.00001", input_cache_read: "0.0000005" } }),
  m("~z-ai/glm-flash-latest", 300, { alias_target: { slug: "z-ai/glm-5.3-flash", name: "" } }),
]);
const lanes = {
  sonnet: { alias: "~anthropic/claude-sonnet-latest", match: "^anthropic/claude-sonnet-\\d+([.-]\\d+)?$" },
  lite: { match: "^google/gemini-\\d+(\\.\\d+)?-flash-lite$" },
};

test("IDs are spelled the way the repo spells them, and the spelling is inferred from the ID", () => {
  assert.equal(formatId("anthropic/claude-sonnet-5.5", "openrouter"), "anthropic/claude-sonnet-5.5");
  assert.equal(formatId("anthropic/claude-sonnet-5.5", "native"), "claude-sonnet-5-5");
  assert.equal(formatId("anthropic/claude-sonnet-5.5", "prefixed-native"), "anthropic/claude-sonnet-5-5");
  assert.equal(formatId("google/gemini-3.8-flash", "native"), "gemini-3.8-flash");
  assert.equal(inferFormat("claude-sonnet-5", "anthropic/claude-sonnet-5"), "native");
  assert.equal(inferFormat("anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5"), "openrouter");
  assert.equal(inferFormat("anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4.5"), "prefixed-native");
  assert.equal(inferFormat("anthropic/claude-3-7-sonnet-latest"), "prefixed-native");
  assert.equal(inferFormat("google/gemini-3.8-flash"), "openrouter");
});

test("a model's lane and spelling are inferred, and it bumps to the lane's newest", () => {
  const native = planModel({ id: "claude-sonnet-5" }, lanes, catalog);
  assert.deepEqual([native.status, native.lane, native.target], ["bump", "sonnet", "claude-sonnet-5-5"]);
  const slug = planModel({ id: "anthropic/claude-sonnet-5" }, lanes, catalog);
  assert.deepEqual([slug.target, slug.currentSlug, slug.laneSlug], ["anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5"]);
  assert.equal(planModel({ id: "google/gemini-3.5-flash-lite" }, lanes, catalog).target, "google/gemini-3.6-flash-lite"); // not :free
  assert.equal(catalog.lookup("gemini-3.6-flash-lite")?.id, "google/gemini-3.6-flash-lite"); // the :free variant shares its slug
});

test("current, ahead, held and unplaceable models never bump", () => {
  assert.equal(planModel({ id: "claude-sonnet-5-5" }, lanes, catalog).status, "current");
  const ahead = new Catalog([...catalog.models, m("google/gemini-9-flash-lite-preview", 999)]);
  assert.equal(planModel({ id: "google/gemini-9-flash-lite-preview", lane: "lite" }, lanes, ahead).status, "ahead");
  assert.deepEqual(planModel({ id: "claude-sonnet-5", hold: "an eval picked it" }, lanes, catalog).notes, ["held: an eval picked it"]);
  assert.equal(planModel({ id: "z-ai/glm-5.3-flash" }, lanes, catalog).status, "error"); // no lane fits
  assert.equal(planModel({ id: "made-up-model" }, lanes, catalog).status, "error"); // not listed anywhere
});

test("provider APIs add models OpenRouter doesn't list, only for lanes with a match and repos that don't call OpenRouter", () => {
  const both = new Catalog(catalog.models, [
    { id: "anthropic/claude-sonnet-5-5", name: "dup of OpenRouter's", created: 200, source: "Anthropic API" },
    { id: "anthropic/claude-sonnet-6", name: "Claude Sonnet 6", created: 500, source: "Anthropic API" },
    { id: "google/gemini-3.7-flash-lite", name: "Gemini 3.7 Flash-Lite", created: 0, source: "Gemini API" }, // no dates there
  ]);
  assert.equal(both.lookup("claude-sonnet-5-5")?.source, undefined); // OpenRouter's entry wins
  assert.deepEqual(both.resolveLane(lanes.sonnet), { slug: "anthropic/claude-sonnet-6" });
  assert.deepEqual(both.resolveLane(lanes.sonnet, true), { slug: "anthropic/claude-sonnet-5.5" });
  assert.deepEqual(catalog.resolveLane(lanes.sonnet), { slug: "anthropic/claude-sonnet-5.5" }); // no keys, no change
  assert.deepEqual(both.resolveLane(lanes.lite), { slug: "google/gemini-3.7-flash-lite" });
  const p = planModel({ id: "claude-sonnet-5" }, lanes, both);
  assert.equal(p.target, "claude-sonnet-6");
  assert.match(p.notes[0], /listed by the Anthropic API, not OpenRouter/);
  assert.equal(planModel({ id: "anthropic/claude-sonnet-5" }, lanes, both).target, "anthropic/claude-sonnet-5.5");
});

test("registries are a list of models, as plain IDs or with overrides, and lint catches mistakes", () => {
  const r = parseRegistry("models:\n  - claude-sonnet-5\n  - id: text-embedding-3-small\n    hold: stored vectors\n");
  assert.deepEqual(r.models, [{ id: "claude-sonnet-5" }, { id: "text-embedding-3-small", hold: "stored vectors" }]);
  assert.deepEqual(lintRegistry(r, lanes), []);
  assert.deepEqual(lintRegistry(parseRegistry("models:\n  - a\n  - a\n  - id: b\n    lane: nope\n"), lanes), ['a: listed twice', 'b: unknown lane "nope"']);
  assert.deepEqual(parseRegistry("").models, []);
  const lint = (text: string) => { const r = parseRegistry(text); return lintRegistry(r, loadLanes(r)).join("\n"); };
  assert.match(lint("models: foo"), /`models` must be a list/);
  assert.throws(() => parseRegistry("- a\n- b"), /must be a mapping/);
  assert.match(lint("models:\n  - id: a\n    holds: typo\n"), /a: unknown key `holds`/);
  assert.match(lint("models: []\nafter-merge: [x]\n"), /unknown key `after-merge`/);
  assert.match(lint("models: []\nlanes:\n  x: { match: '(' }\n"), /lane x: match isn't a valid regex/);
  assert.match(lint("models: []\nlanes:\n  x: { macth: 'a' }\n"), /lane x: unknown key `macth`[\s\S]*lane x: needs alias, match or chain/);
  assert.match(lint("models: []\nignore: ['*.snap']\n"), /plain prefixes/);
  assert.match(lint("models: []\nignore: test/\nnotes: [a]\n"), /`ignore` must be a list[\s\S]*`notes` must be text/);
});

test("alias-only lanes and retired models still get a lane", () => {
  const cat = new Catalog([
    ...catalog.models,
    m("x-ai/grok-4", 100), m("x-ai/grok-4-fast", 150), m("x-ai/grok-5", 200),
    m("~x-ai/grok-latest", 200, { alias_target: { slug: "x-ai/grok-5", name: "" } }),
  ]);
  const withGrok = { ...lanes, grok: { alias: "~x-ai/grok-latest" } };
  const old = planModel({ id: "x-ai/grok-4" }, withGrok, cat);
  assert.deepEqual([old.status, old.lane, old.target], ["bump", "grok", "x-ai/grok-5"]);
  assert.equal(planModel({ id: "x-ai/grok-4-fast" }, withGrok, cat).status, "error"); // a different family
  const retired = planModel({ id: "claude-sonnet-4-5" }, lanes, cat); // not listed anywhere any more
  assert.deepEqual([retired.status, retired.lane, retired.target], ["bump", "sonnet", "claude-sonnet-5-5"]);
  assert.match(retired.notes.join(" "), /isn't listed anymore/);
});

test("built-in lanes place dated, preview, old-style and retired IDs, and resolve each family's newest", () => {
  const cat = new Catalog([
    m("anthropic/claude-sonnet-5.5", 500), m("~anthropic/claude-sonnet-latest", 500, { alias_target: { slug: "anthropic/claude-sonnet-5.5", name: "" } }),
    m("anthropic/claude-opus-5.5", 500), m("~anthropic/claude-opus-latest", 500, { alias_target: { slug: "anthropic/claude-opus-5.5", name: "" } }),
    m("anthropic/claude-haiku-5.5", 500), m("~anthropic/claude-haiku-latest", 500, { alias_target: { slug: "anthropic/claude-haiku-5.5", name: "" } }),
    m("openai/gpt-4o", 100), m("openai/gpt-4o-2024-08-06", 100), m("openai/gpt-5.5", 400), m("openai/gpt-4o-mini", 100), m("openai/gpt-5.4-mini", 300),
    m("~openai/gpt-mini-latest", 300, { alias_target: { slug: "openai/gpt-5.4-mini", name: "" } }),
    m("openai/gpt-5-nano", 200), m("openai/gpt-5.4-nano", 300), m("openai/gpt-6-sol-pro", 500), m("openai/gpt-6.1-sol-pro", 600),
    m("openai/o3", 200), m("openai/o4-mini", 200),
    m("google/gemini-3-flash-preview", 200), m("google/gemini-3.8-flash", 500),
    m("~google/gemini-flash-latest", 500, { alias_target: { slug: "google/gemini-3.8-flash", name: "" } }),
    m("deepseek/deepseek-v4-pro", 200), m("deepseek/deepseek-v4-pro-0813", 300),
    m("~deepseek/deepseek-pro-latest", 300, { alias_target: { slug: "deepseek/deepseek-v4-pro-0813", name: "" } }),
    m("moonshotai/kimi-k2.5", 200), m("moonshotai/kimi-k3", 300),
    m("~moonshotai/kimi-latest", 300, { alias_target: { slug: "moonshotai/kimi-k3", name: "" } }),
    m("qwen/qwen3.7-max", 200), m("qwen/qwen3.8-max-0902", 300),
    m("mistralai/mistral-large-2512", 200), m("mistralai/mistral-large-4-0", 300),
  ]);
  const builtIn = loadLanes({ models: [] });
  const plan = (id: string) => { const p = planModel({ id }, builtIn, cat); return [p.status, p.lane, p.target]; };
  assert.deepEqual(plan("claude-sonnet-4-5-20250929"), ["bump", "anthropic-sonnet", "claude-sonnet-5-5"]); // dated
  assert.deepEqual(plan("claude-3-5-sonnet-20241022"), ["bump", "anthropic-sonnet", "claude-sonnet-5-5"]); // version first
  assert.deepEqual(plan("claude-3-7-sonnet-latest"), ["bump", "anthropic-sonnet", "claude-sonnet-5-5"]); // a versioned -latest isn't moving
  assert.deepEqual(plan("claude-3-opus-20240229"), ["bump", "anthropic-opus", "claude-opus-5-5"]);
  assert.deepEqual(plan("claude-3-5-haiku-latest"), ["bump", "anthropic-haiku", "claude-haiku-5-5"]);
  assert.deepEqual(plan("gpt-4o"), ["bump", "openai-gpt", "gpt-5.5"]);
  assert.deepEqual(plan("gpt-4o-2024-08-06"), ["bump", "openai-gpt", "gpt-5.5"]);
  assert.deepEqual(plan("gpt-4o-mini"), ["bump", "openai-mini", "gpt-5.4-mini"]);
  assert.deepEqual(plan("gpt-5-nano"), ["bump", "openai-nano", "gpt-5.4-nano"]);
  assert.deepEqual(plan("gpt-6-sol-pro"), ["bump", "openai-sol-pro", "gpt-6.1-sol-pro"]);
  assert.deepEqual(plan("o3"), ["current", "openai-o", "o3"]); // a finished line is current, not an error
  assert.deepEqual(plan("o4-mini"), ["current", "openai-o-mini", "o4-mini"]);
  assert.deepEqual(plan("gemini-3-flash-preview"), ["bump", "gemini-flash", "gemini-3.8-flash"]);
  assert.deepEqual(plan("gemini-2.0-flash-001"), ["bump", "gemini-flash", "gemini-3.8-flash"]); // Vertex's suffix, retired
  assert.deepEqual(plan("deepseek/deepseek-v4-pro"), ["bump", "deepseek-pro", "deepseek/deepseek-v4-pro-0813"]);
  assert.deepEqual(plan("moonshotai/kimi-k2.5"), ["bump", "kimi", "moonshotai/kimi-k3"]);
  assert.deepEqual(plan("qwen/qwen3.7-max"), ["bump", "qwen-max", "qwen/qwen3.8-max-0902"]); // dated-only releases are targets
  assert.deepEqual(plan("mistralai/mistral-large-2512"), ["bump", "mistral-large", "mistralai/mistral-large-4-0"]);
});

test("moving aliases are current, and embedding models are held unless given a lane", () => {
  for (const id of ["gemini-flash-latest", "mistral-large-latest", "~anthropic/claude-sonnet-latest", "deepseek-chat"]) {
    assert.equal(planModel({ id }, lanes, catalog).status, "current", id);
  }
  const embed = planModel({ id: "text-embedding-3-small" }, lanes, catalog);
  assert.equal(embed.status, "hold");
  assert.match(embed.notes[0], /held automatically/);
  assert.equal(planModel({ id: "gemini-embedding-001" }, lanes, catalog).status, "hold");
  const withLane = { ...lanes, embed: { match: "^openai/text-embedding-\\d+-small$" } };
  assert.equal(planModel({ id: "text-embedding-3-small", lane: "embed" }, withLane, catalog).status, "current");
});

test("newest sorts consistently when some models have no release date", () => {
  const ms = [m("google/gemini-3.6-flash", 300), m("google/gemini-3.10-flash", 0), m("google/gemini-3.5-flash", 100)];
  assert.equal(newest(ms)!.id, "google/gemini-3.10-flash");
  assert.equal(newest(ms.reverse())!.id, "google/gemini-3.10-flash");
  assert.equal(newest([m("a/x-1", 300), m("a/x-2", 100)])!.id, "a/x-1"); // all dated: by date
});

test("a closed bump PR declines its moves, and PR bodies carry what's needed to decide that", () => {
  const plan = planRepo(parseRegistry(REG), lanes, catalog);
  const declined = decline(plan, new Map([["claude-sonnet-5=claude-sonnet-5-5", 7]]));
  assert.deepEqual(declined.models.map((x) => x.status), ["declined", "bump"]);
  assert.notEqual(declined.hash, plan.hash);
  assert.match(declined.models[0].notes[0], /#7 was closed without merging/);
  const body = prBody(parseRegistry(REG), declined, "notes", ["a problem"], new Map(), "", 2);
  assert.deepEqual(prMarkers(body), { hash: declined.hash, attempt: 2, moves: ["google/gemini-3.5-flash-lite=google/gemini-3.6-flash-lite"], superseded: false });
  assert.match(body, /Models not changed[\s\S]*`claude-sonnet-5` \(declined\)/);
  assert.equal(prMarkers(prBody(parseRegistry(REG), plan, "notes", [], new Map())).attempt, 0);
  assert.equal(prMarkers(`${body}\n<!-- modelwatch-superseded -->`).superseded, true);
});

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mw-test-"));
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

const REG = `# chat model
models:
  - claude-sonnet-5   # the chat model
  - id: google/gemini-3.5-flash-lite
    eval: npm run eval -- <new>
`;

test("uses are found outside ignored paths, and the diff check wants the new ID and no ignored changes", () => {
  const dir = repoWith({ ".github/modelwatch.yml": REG, "src/llm.ts": 'export const MODEL = "claude-sonnet-5";\n', "docs/models.md": "claude-sonnet-5\n" });
  const r: Registry = { ...parseRegistry(REG), ignore: ["docs/"] };
  assert.deepEqual(findUses(dir, r, "claude-sonnet-5"), ["src/llm.ts:1"]);
  for (const line of ['"claude-sonnet-5.5"', "claude-sonnet-5-20260301", "xclaude-sonnet-5"]) assert.equal(idPattern("claude-sonnet-5").test(line), false, line);
  for (const line of ['"claude-sonnet-5"', "models/claude-sonnet-5:generate", "uses claude-sonnet-5."]) assert.equal(idPattern("claude-sonnet-5").test(line), true, line);
  const plan = planRepo(r, lanes, catalog);
  const base = head(dir);
  const check = () => verifyDiff(dir, base, r, plan, listChanges(dir, base));
  writeFileSync(join(dir, "src/llm.ts"), 'export const MODEL = "claude-sonnet-5-5";\n');
  assert.deepEqual(check(), ["nothing in the diff uses `google/gemini-3.6-flash-lite` (replacing `google/gemini-3.5-flash-lite`)"]);
  writeFileSync(join(dir, "docs/models.md"), "changed\n");
  assert.match(check().join("\n"), /docs\/models.md is in an ignored path/);
  assert.equal(isIgnored(r, ".github/modelwatch.yml"), true);
  // A new file counts as using the new ID, and is flagged so a reviewer checks it belongs.
  writeFileSync(join(dir, "src/lite.ts"), 'export const LITE = "google/gemini-3.6-flash-lite";\n');
  const problems = check();
  assert.doesNotMatch(problems.join("\n"), /gemini-3.6-flash-lite/);
  assert.match(problems.join("\n"), /added new files; check they belong: `src\/lite.ts`/);
});

const head = (dir: string) => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

test("listChanges sees edits, new files, deletions and symlinks against the base, even if the agent committed", () => {
  const dir = repoWith({ "a.txt": "a\n", "b.txt": "b\n", "run.sh": "#!/bin/sh\n", ".gitignore": "out/\n" });
  const base = head(dir);
  writeFileSync(join(dir, "a.txt"), "A\n");
  rmSync(join(dir, "b.txt"));
  writeFileSync(join(dir, "c.txt"), "c\n");
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "out/x"), "ignored\n");
  symlinkSync("a.txt", join(dir, "link"));
  execFileSync("git", ["add", "c.txt"], { cwd: dir });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "agent"], { cwd: dir });
  const got = listChanges(dir, base).map((c) => [c.path, c.kind, c.content?.toString() ?? null, c.mode]).sort();
  assert.deepEqual(got, [
    ["a.txt", "modified", "A\n", "100644"],
    ["b.txt", "deleted", null, "100644"],
    ["c.txt", "modified", "c\n", "100644"], // committed by the agent: still a change from the base
    ["link", "added", "a.txt", "120000"],
  ]);
});

test("findUses skips submodules and symlinks", () => {
  const dir = repoWith({ "a.ts": 'm = "claude-sonnet-5"\n' });
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `160000,${head(dir)},vendor/sub`], { cwd: dir });
  mkdirSync(join(dir, "vendor/sub"), { recursive: true });
  symlinkSync("a.ts", join(dir, "b.ts"));
  execFileSync("git", ["add", "b.ts"], { cwd: dir });
  assert.deepEqual(findUses(dir, { models: [] }, "claude-sonnet-5"), ["a.ts:1"]);
});

test("updateRegistry moves bumped models to their new IDs, merges duplicates, preserves explicit lanes and comments", () => {
  const reg = REG + `  - id: claude-sonnet-4-5   # retired, so it needs a lane
    lane: sonnet
  - id: anthropic/claude-sonnet-5-20260301
    lane: sonnet
notes: ${"a long line that must not be rewrapped ".repeat(4)}
`;
  const dir = repoWith({ ".github/modelwatch.yml": reg });
  updateRegistry(dir, planRepo(parseRegistry(reg), lanes, catalog));
  const after = readFileSync(join(dir, ".github/modelwatch.yml"), "utf8");
  assert.match(after, /- claude-sonnet-5-5 {3}# the chat model\n/); // everything else byte for byte
  assert.match(after, /id: google\/gemini-3.6-flash-lite\n/);
  assert.match(after, /^# chat model/);
  assert.doesNotMatch(after, /claude-sonnet-4-5|retired/); // moved to claude-sonnet-5-5, already listed
  assert.match(after, /- id: anthropic\/claude-sonnet-5-5\n    lane: sonnet\n/);
  assert.match(after, /notes: (a long line that must not be rewrapped ){3}/);
  assert.deepEqual(lintRegistry(parseRegistry(after), lanes), []);
});

test("updateRegistry handles a one-line models list, merging entries without leaving a stray comma", () => {
  const flow = "models: [claude-sonnet-5, claude-sonnet-5-5] # chat\n";
  const dir = repoWith({ ".github/modelwatch.yml": flow });
  updateRegistry(dir, planRepo(parseRegistry(flow), lanes, catalog));
  const after = readFileSync(join(dir, ".github/modelwatch.yml"), "utf8");
  assert.deepEqual(parseRegistry(after).models, [{ id: "claude-sonnet-5-5" }]);
});

test("PR body: badge, after-merge steps and evals with IDs filled in, leftovers, and machine-readable bumps", () => {
  const r: Registry = { ...parseRegistry(REG), after_merge: ["Set CHAT_MODEL to <new> if it's <old>, then redeploy."] };
  const plan: Plan = planRepo(r, lanes, catalog);
  const body = prBody(r, plan, "### Changes beyond the ID swap\n- None", [], new Map([["claude-sonnet-5", ["docs/a.md:3"]]]), "Agent: x");
  assert.ok(body.startsWith("[![modelwatch: model bump](https://img.shields.io/badge/modelwatch-model%20bump-2f6feb)](https://github.com/abromberg/modelwatch)"));
  assert.match(body, /- \[ \] Set CHAT_MODEL to the new ID if it's the old ID, then redeploy./);
  assert.match(body, /- \[ \] `npm run eval -- google\/gemini-3.6-flash-lite`/);
  assert.match(body, /`claude-sonnet-5`: docs\/a.md:3/);
  assert.match(body, /<sub>Opened by \[modelwatch\]\(https:\/\/github.com\/abromberg\/modelwatch\) · Agent: x<\/sub>/);
  assert.match(body, /<!-- modelwatch-bumps: anthropic\/claude-sonnet-5=anthropic\/claude-sonnet-5.5,google\/gemini-3.5-flash-lite=google\/gemini-3.6-flash-lite -->/);
});

test("configure PRs carry the format and lanes to the agent, and say when there's nothing to watch", () => {
  const prompt = configurePrompt("o/r");
  assert.match(prompt, /## Registry format\n# Registry format/);
  assert.match(prompt, /anthropic-sonnet:/);
  const none = configureBody({ models: [] }, { hash: "h", errors: [], models: [] }, [], "### What I found\n- nothing", "stats");
  assert.match(none, /No LLM model IDs were found/);
  assert.doesNotMatch(none, /Draft/);
  assert.match(configureBody(null, null, ["can't read it: x"], "", ""), /Draft: the registry has problems[\s\S]*can't read it/);
});

test("the agent model resolves aliases, and the stats line reports what OpenRouter charged", () => {
  assert.equal(agentModel({ models: [] }, catalog), "z-ai/glm-5.3-flash");
  assert.equal(agentModel({ models: [], agent_model: "~anthropic/claude-sonnet-latest" }, catalog), "anthropic/claude-sonnet-5.5");
  assert.throws(() => agentModel({ models: [], agent_model: "nope/nope" }, catalog));
  const run = { ok: true, turns: 31, durationMs: 372000, costUsd: 3.5, final: "" };
  assert.equal(agentStats("z-ai/glm-5.3-flash", run), "Agent: `z-ai/glm-5.3-flash` via Pi, 31 turns, 6 min, $3.50 charged by OpenRouter");
  assert.equal(agentStats("m", { ...run, turns: 5, durationMs: 16400, costUsd: 0.000035502 }), "Agent: `m` via Pi, 5 turns, 16s, $0.000036 charged by OpenRouter");
  assert.doesNotMatch(agentStats("m", { ...run, costUsd: null }), /\$/);
});

test("the agent's environment has no credentials", () => {
  const env = repoEnv({ PATH: "/bin", GITHUB_TOKEN: "t", MODELWATCH_TOKEN: "t", OPENROUTER_API_KEY: "k", AWS_SECRET: "s", CI: "true" });
  assert.deepEqual(env, { PATH: "/bin", CI: "true" });
});

test("withZdr forces zdr and keeps other provider preferences", () => {
  assert.deepEqual(withZdr({ model: "m", provider: { zdr: false, sort: "price" } }), { model: "m", provider: { zdr: true, sort: "price" } });
  assert.deepEqual(withZdr({ model: "m" }).provider, { zdr: true });
});

test("commits go through the API: blobs, a tree on the parent's, a commit, then the branch moves (or is made)", async () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => {
    const path = url.replace("https://api.github.com/", "");
    const body = init.body && JSON.parse(init.body);
    calls.push(`${init.method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });
    if (path === "repos/o/r/git/commits/base") return json(200, { tree: { sha: "basetree" } });
    if (path === "repos/o/r/git/blobs") return json(201, { sha: "blob1" });
    if (path === "repos/o/r/git/trees") return json(201, { sha: "tree1" });
    if (path === "repos/o/r/git/commits") return json(201, { sha: "commit1" });
    if (path === "repos/o/r/git/ref/heads/modelwatch/x") return json(404, {});
    if (path === "repos/o/r/git/refs") return json(201, {});
    throw new Error(`unexpected ${path}`);
  }) as typeof fetch;
  try {
    const sha = await commitFiles("t", "o/r", {
      branch: "modelwatch/x", parent: "base", message: "m",
      changes: [{ path: "a.ts", kind: "modified", content: Buffer.from("x"), mode: "100644" }, { path: "gone.ts", kind: "deleted", content: null, mode: "100644" }],
    });
    assert.equal(sha, "commit1");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [
    "GET repos/o/r/git/commits/base",
    'POST repos/o/r/git/blobs {"content":"eA==","encoding":"base64"}',
    'POST repos/o/r/git/trees {"base_tree":"basetree","tree":[{"path":"a.ts","mode":"100644","type":"blob","sha":"blob1"},{"path":"gone.ts","mode":"100644","type":"blob","sha":null}]}',
    'POST repos/o/r/git/commits {"message":"m","tree":"tree1","parents":["base"]}',
    "GET repos/o/r/git/ref/heads/modelwatch/x",
    'POST repos/o/r/git/refs {"ref":"refs/heads/modelwatch/x","sha":"commit1"}',
  ]);
});

test("the action and the runner workflow are valid YAML, and the runner checks each repo in its own job", async () => {
  const { parse } = await import("yaml");
  const action = parse(readFileSync(join(import.meta.dirname, "../action.yml"), "utf8"));
  assert.equal(action.outputs.repos.value, "${{ steps.main.outputs.repos }}");
  const runner = parse(readFileSync(join(import.meta.dirname, "../runner/modelwatch.yml"), "utf8"));
  assert.equal(runner.jobs.modelwatch.strategy.matrix.repo, "${{ fromJSON(needs.repos.outputs.repos) }}");
  assert.equal(runner.jobs.modelwatch.steps[0].with.repos, "${{ matrix.repo }}");
});

test("models modelwatch can't plan are listed in the PR for the registry to be fixed", () => {
  const r = parseRegistry(REG + "  - made-up-model\n");
  const body = prBody(r, planRepo(r, lanes, catalog), "notes", [], new Map());
  assert.match(body, /### Fix in `\.github\/modelwatch\.yml`[\s\S]*- `made-up-model`: it isn't listed/);
  assert.doesNotMatch(body, /Models not changed/);
});
