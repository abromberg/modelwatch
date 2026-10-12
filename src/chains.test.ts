import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, prBody, updateRegistry } from "./bump.ts";
import { Catalog, type OrModel } from "./models.ts";
import { planModel, planRepo, renderPlan } from "./plan.ts";
import { loadLanes, parseRegistry, type LaneRule, type Registry } from "./registry.ts";

const model = (id: string, created: number, extra: Partial<OrModel> = {}): OrModel => ({ id, name: id, created, ...extra });
const original = "example/jev";
const replacement = "microsoft/microsoft-decision-1";
const decision = { chain: [original, "example/intermediate", replacement] };

test("an explicit chain selects its last entry across providers, regardless of dates or missing intermediate models", () => {
  for (const created of [400, 300, 100, 0]) {
    const catalog = new Catalog([model(original, 300), model(replacement, created)]);
    const p = planModel({ id: original, lane: "decision" }, { decision }, catalog);
    assert.equal(p.status, "bump");
    assert.equal(p.target, replacement);
    assert.match(p.notes.join(" "), /last entry, regardless of release date/);
    assert.equal(planModel({ id: replacement, lane: "decision" }, { decision }, catalog).status, "current");
  }
});

test("chains are opt-in and don't change automatic family lanes or held models", () => {
  const first = "anthropic/claude-sonnet-5";
  const latest = "anthropic/claude-sonnet-5.5";
  const catalog = new Catalog([model(first, 100), model(latest, 200), model(replacement, 50)]);
  const lanes = {
    decision: { chain: [first, replacement] },
    sonnet: { match: "^anthropic/claude-sonnet-" },
  };
  assert.equal(planModel({ id: first }, lanes, catalog).target, latest);
  assert.equal(planModel({ id: first, lane: "decision" }, lanes, catalog).target, replacement);
  assert.equal(planModel({ id: first, lane: "decision", hold: "eval picked it" }, lanes, catalog).status, "hold");
  assert.equal(planModel({ id: replacement }, { decision }, catalog).status, "error");
});

test("a chain can deliberately roll back, or move a retired model to its selected target", () => {
  const catalog = new Catalog([model(original, 100), model(replacement, 200)]);
  const rollback = { decision: { chain: [original, replacement, original] } };
  assert.equal(planRepo({ models: [{ id: replacement, lane: "decision" }] }, rollback, catalog).models[0].target, original);
  assert.equal(planModel({ id: original, lane: "decision" }, rollback, catalog).status, "current");
  const retired = planModel({ id: "example/retired", lane: "decision" }, { decision }, catalog);
  assert.equal(retired.status, "bump");
  assert.equal(retired.target, replacement);
});

test("a missing chain target errors instead of silently falling back, and provider-only targets respect ID format", () => {
  const nativeTarget = "anthropic/claude-sonnet-5-5";
  const catalog = new Catalog([model("anthropic/claude-sonnet-5", 300)], [model(nativeTarget, 100, { source: "Anthropic API" })]);
  const lanes = { decision: { chain: [nativeTarget] } };
  const native = planModel({ id: "claude-sonnet-5", lane: "decision" }, lanes, catalog);
  assert.equal(native.status, "bump");
  assert.equal(native.target, "claude-sonnet-5-5");
  const router = planModel({ id: "anthropic/claude-sonnet-5", lane: "decision" }, lanes, catalog);
  assert.equal(router.status, "error");
  assert.match(router.notes.join(" "), /isn't listed on OpenRouter/);
  const missing = planModel({ id: "claude-sonnet-5", lane: "decision" }, { decision }, catalog);
  assert.equal(missing.status, "error");
  assert.match(missing.notes.join(" "), /chain target microsoft\/microsoft-decision-1 isn't listed/);
});

test("chain IDs are converted to the repo's spelling", () => {
  const catalog = new Catalog([model("anthropic/claude-sonnet-5", 300), model("anthropic/claude-sonnet-5.5", 100)]);
  const lanes = { decision: { chain: ["anthropic/claude-sonnet-5.5"] } };
  for (const [id, target] of [
    ["claude-sonnet-5", "claude-sonnet-5-5"],
    ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-5-5"],
    ["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5.5"],
  ]) {
    assert.equal(planModel({ id, lane: "decision" }, lanes, catalog).target, target);
  }
});

test("invalid chain configuration produces actionable errors before planning", () => {
  for (const rule of [
    "{ chain: [] }", "{ chain: null }", "{ chain: microsoft/model }", "{ chain: [123] }",
    "{ chain: [model-without-provider] }", "{ chain: ['~example/latest'] }", "{ chain: ['example/two words'] }",
    "{ chain: [microsoft/model], match: '.*' }", "{ chain: [microsoft/model], alias: '~example/latest' }",
    "null", "[]", "plain-text",
  ]) {
    const r = parseRegistry(`models: []\nlanes:\n  decision: ${rule}\n`);
    const plan = planRepo(r, loadLanes(r), new Catalog([]));
    assert.ok(plan.errors.some(e => e.startsWith("lane decision:")), rule);
    assert.deepEqual(plan.models, []);
  }
  const r = parseRegistry("models: []\nlanes: []\n");
  assert.match(planRepo(r, loadLanes(r), new Catalog([])).errors.join(" "), /lanes.*must be a mapping/);
});

test("a chain assignment and its comments survive multiple upgrades as the owner appends choices", () => {
  const reg = `models:
  - id: example/jev # decision calls
    lane: decision # keep this role
    eval: npm run eval -- <new>
lanes:
  decision:
    chain:
      - example/jev
      - microsoft/microsoft-decision-1
notes: Leave my prompts alone.
`;
  const dir = mkdtempSync(join(tmpdir(), "mw-chain-test-"));
  try {
    mkdirSync(join(dir, ".github"));
    const path = join(dir, ".github/modelwatch.yml");
    writeFileSync(path, reg);
    const catalog = new Catalog([model(original, 300), model(replacement, 200), model("other/favorite", 100)]);
    let r = parseRegistry(reg);
    updateRegistry(dir, planRepo(r, loadLanes(r), catalog));
    const after = readFileSync(path, "utf8");
    assert.equal(after, reg.replace("id: example/jev", `id: ${replacement}`));

    // Append a preference whose release date is older still, then run again.
    writeFileSync(path, after.replace("notes:", "      - other/favorite\nnotes:"));
    r = parseRegistry(readFileSync(path, "utf8"));
    const next = planRepo(r, loadLanes(r), catalog);
    assert.equal(next.models[0].target, "other/favorite");
    updateRegistry(dir, next);
    const final = readFileSync(path, "utf8");
    assert.match(final, /id: other\/favorite # decision calls/);
    assert.match(final, /lane: decision # keep this role/);
    assert.match(final, /eval: npm run eval -- <new>/);
    r = parseRegistry(final);
    assert.equal(planRepo(r, loadLanes(r), catalog).models[0].status, "current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("different roles cannot silently merge when they select the same model ID", () => {
  const catalog = new Catalog([model(original, 300), model(replacement, 100), model("example/title", 200)]);
  const r: Registry = { models: [{ id: original, lane: "decision" }, { id: "example/title", lane: "title" }] };
  const lanes: Record<string, LaneRule> = { decision, title: { chain: [replacement] } };
  assert.match(planRepo(r, lanes, catalog).errors.join(" "), /one model ID cannot follow two lanes/);
  r.models[1] = { id: replacement, hold: "keep it" };
  assert.match(planRepo(r, lanes, catalog).errors.join(" "), /one model ID cannot follow two lanes/);
});

test("registry updates use final destinations when two chains swap IDs", () => {
  const reg = `models:
  - id: example/jev
    lane: decision
  - id: microsoft/microsoft-decision-1
    lane: title
`;
  const r = parseRegistry(reg);
  const lanes = { decision, title: { chain: [replacement, original] } };
  const catalog = new Catalog([model(original, 100), model(replacement, 200)]);
  const plan = planRepo(r, lanes, catalog);
  assert.deepEqual(plan.errors, []);
  const dir = mkdtempSync(join(tmpdir(), "mw-chain-swap-"));
  try {
    mkdirSync(join(dir, ".github"));
    const path = join(dir, ".github/modelwatch.yml");
    writeFileSync(path, reg);
    updateRegistry(dir, plan);
    const updated = parseRegistry(readFileSync(path, "utf8"));
    assert.deepEqual(updated.models, [{ id: replacement, lane: "decision" }, { id: original, lane: "title" }]);
    assert.ok(planRepo(updated, lanes, catalog).models.every(m => m.status === "current"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chain plans explain intentional older targets to the agent and reviewer", () => {
  const catalog = new Catalog([model(original, 300), model(replacement, 100)]);
  const r: Registry = { models: [{ id: original, lane: "decision", eval: "eval --model <new>" }] };
  const plan = planRepo(r, { decision }, catalog);
  assert.match(renderPlan(plan), /\| target \|/);
  const prompt = buildPrompt(r, plan, catalog, "owner/repo", new Map());
  assert.match(prompt, /deliberately select an older model or a different family/);
  assert.ok(prompt.includes(replacement));
  const body = prBody(r, plan, "Notes", [], new Map());
  assert.match(body, /selected by the decision chain/);
  assert.ok(body.includes(`eval --model ${replacement}`));
  assert.ok(body.includes(`modelwatch-bumps: ${original}=${replacement}`));
});
