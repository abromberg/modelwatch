import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { git } from "./git.ts";

/** The modelwatch checkout itself (code and the built-in lanes). */
export const HOME = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_URL = "https://github.com/abromberg/modelwatch";
/** The registry format, linked from PRs. */
export const DOCS_URL = `${REPO_URL}/blob/main/docs/registry.md`;
/** A badge for the top of modelwatch's PRs, e.g. badge("model bump"). */
export const badge = (what: string) =>
  `[![modelwatch: ${what}](https://img.shields.io/badge/modelwatch-${encodeURIComponent(what)}-2f6feb)](${REPO_URL})`;
/** The footer line of modelwatch's PRs. */
export const footer = (stats: string) => `<sub>Opened by [modelwatch](${REPO_URL})${stats ? ` · ${stats}` : ""}</sub>`;

/** Where a repo keeps its registry. */
export const REGISTRY = ".github/modelwatch.yml";

export type Format = "openrouter" | "native" | "prefixed-native";
export type LaneRule = { alias?: string; match?: string; chain?: string[] };

/** A model the repo uses. Only `id` is required; the rest overrides what modelwatch infers. */
export type Model = {
  id: string; // spelled as in the code
  lane?: string;
  format?: Format;
  hold?: string; // never bump, for this reason
  eval?: string; // command to run before merging a bump; <old> and <new> are filled in
};

export type Registry = {
  models: Model[];
  notes?: string; // for the agent
  after_merge?: string[]; // checklist after any bump; <old> and <new> are filled in
  ignore?: string[]; // paths that must never change
  lanes?: Record<string, LaneRule>; // added to (or overriding) the built-in lanes
  agent_model?: string; // OpenRouter slug or ~alias; default in agent.ts
};

/** Parses a registry; lintRegistry says what's wrong with one that parses but doesn't fit the format. */
export function parseRegistry(text: string): Registry {
  const r = parse(text) ?? {};
  if (typeof r !== "object" || Array.isArray(r)) throw new Error("the file must be a mapping, with the models under `models:`");
  const models = r.models ?? [];
  return { ...r, models: Array.isArray(models) ? models.map((m: unknown) => (typeof m === "string" ? { id: m } : m)) : models };
}

export function loadRegistry(dir: string): Registry {
  const path = join(dir, REGISTRY);
  if (!existsSync(path)) throw new Error(`no ${REGISTRY} in ${dir}`);
  return parseRegistry(readFileSync(path, "utf8"));
}

// Read once, at startup: an agent that runs later could edit modelwatch's own files.
export const LANES_TEXT = readFileSync(join(HOME, "lanes.yaml"), "utf8");
const BUILT_IN_LANES: Record<string, LaneRule> = parse(LANES_TEXT);

/** The registry's own lanes, then the built-in ones; when inferring a model's lane, the first match wins. */
export function loadLanes(r: Registry): Record<string, LaneRule> {
  const own = r.lanes && typeof r.lanes === "object" && !Array.isArray(r.lanes) ? r.lanes : {};
  return { ...own, ...Object.fromEntries(Object.entries(BUILT_IN_LANES).filter(([k]) => !(k in own))) };
}

/** Paths the agent must not change. The registry is one: modelwatch updates it. */
export function isIgnored(r: Registry, file: string): boolean {
  return file === REGISTRY || !!r.ignore?.some((g) => file === g || file.startsWith(g.endsWith("/") ? g : g + "/"));
}

/** Matches `id` as a whole ID: not claude-sonnet-5 inside claude-sonnet-5.5 or claude-sonnet-5-20260301. */
export const idPattern = (id: string) => new RegExp(`(?<![\\w.-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-]|\\.\\d)`);

/** Every line in a checkout that mentions `id`, as "file:line", outside ignored paths. */
export function findUses(dir: string, r: Registry, id: string): string[] {
  const out: string[] = [];
  for (const file of git(dir, ["ls-files", "-z"], { trim: false }).split("\0")) {
    if (!file || isIgnored(r, file)) continue;
    const st = lstatSync(join(dir, file), { throwIfNoEntry: false });
    if (!st?.isFile() || st.size > 1 << 20) continue; // submodules, symlinks, and huge files
    const path = join(dir, file);
    const text = readFileSync(path, "utf8");
    const re = idPattern(id);
    if (text.includes("\0") || !re.test(text)) continue;
    text.split("\n").forEach((line, i) => re.test(line) && out.push(`${file}:${i + 1}`));
  }
  return out;
}

const KEYS = ["models", "notes", "after_merge", "ignore", "lanes", "agent_model"];
const MODEL_KEYS = ["id", "lane", "format", "hold", "eval"];
const LANE_KEYS = ["alias", "match", "chain"];
const isMapping = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v);
const isText = (v: unknown) => typeof v === "string";
/** Unknown keys are errors: a misspelled `hold` would otherwise let a pinned model move. */
const unknownKeys = (o: object, known: string[], where: string) =>
  Object.keys(o).filter((k) => !known.includes(k)).map((k) => `${where}unknown key \`${k}\` (expected one of ${known.join(", ")})`);

/** Structural problems in a registry; empty when it's usable. */
export function lintRegistry(r: Registry, lanes: Record<string, LaneRule>): string[] {
  const errs: string[] = [...unknownKeys(r, KEYS, "")];
  const ids = new Set<string>();
  if (r.lanes !== undefined && !isMapping(r.lanes)) errs.push("`lanes` must be a mapping of names to rules");
  for (const [name, rule] of Object.entries(lanes)) {
    if (!isMapping(rule)) {
      errs.push(`lane ${name}: must be a mapping`);
      continue;
    }
    errs.push(...unknownKeys(rule, LANE_KEYS, `lane ${name}: `));
    if (rule.alias !== undefined && !isText(rule.alias)) errs.push(`lane ${name}: alias must be text`);
    if (rule.match !== undefined) {
      try {
        new RegExp(rule.match);
      } catch (e) {
        errs.push(`lane ${name}: match isn't a valid regex (${(e as Error).message})`);
      }
    }
    if (rule.chain === undefined && rule.alias === undefined && rule.match === undefined) errs.push(`lane ${name}: needs alias, match or chain`);
    if (rule.chain !== undefined) {
      if (!Array.isArray(rule.chain) || !rule.chain.length ||
          !rule.chain.every((id) => typeof id === "string" && /^[\w.-]+\/[^\s/]+$/.test(id))) {
        errs.push(`lane ${name}: chain must be a non-empty list of provider/model IDs`);
      }
      if (rule.alias !== undefined || rule.match !== undefined) errs.push(`lane ${name}: chain cannot be combined with alias or match`);
    }
  }
  if (!Array.isArray(r.models)) return ["`models` must be a list"];
  for (const m of r.models) {
    if (typeof m?.id !== "string" || !m.id) {
      errs.push(`a model has no id: ${JSON.stringify(m)}`);
      continue;
    }
    errs.push(...unknownKeys(m, MODEL_KEYS, `${m.id}: `));
    if (ids.has(m.id)) errs.push(`${m.id}: listed twice`);
    ids.add(m.id);
    if (m.lane && !lanes[m.lane]) errs.push(`${m.id}: unknown lane "${m.lane}"`);
    if (m.format && !["openrouter", "native", "prefixed-native"].includes(m.format)) errs.push(`${m.id}: bad format "${m.format}"`);
    for (const k of ["hold", "eval"] as const) if (m[k] !== undefined && typeof m[k] !== "string") errs.push(`${m.id}: ${k} must be text`);
  }
  if (r.after_merge !== undefined && !(Array.isArray(r.after_merge) && r.after_merge.every(isText))) errs.push("`after_merge` must be a list of text");
  if (r.ignore !== undefined && !(Array.isArray(r.ignore) && r.ignore.every(isText))) errs.push("`ignore` must be a list of paths");
  for (const g of Array.isArray(r.ignore) ? r.ignore : []) {
    if (isText(g) && /[*?[]/.test(g)) errs.push(`ignore: ${g}: paths are plain prefixes (a folder or a file), not globs`);
  }
  if (r.notes !== undefined && !isText(r.notes)) errs.push("`notes` must be text");
  if (r.agent_model !== undefined && !isText(r.agent_model)) errs.push("`agent_model` must be text");
  return errs;
}
