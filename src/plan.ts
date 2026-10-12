// Decides which models should move. Each model's lane (inferred from the model unless the registry names one)
// resolves to the newest model in the catalog, or the last entry of a repo's explicitly assigned chain.
import { createHash } from "node:crypto";
import { formatId, inferFormat } from "./format.ts";
import { Catalog, familyPattern, modelKey, newer, type OrModel } from "./models.ts";
import { lintRegistry, type LaneRule, type Model, type Registry } from "./registry.ts";

// declined: an earlier PR with this exact move was closed without merging.
export type Status = "current" | "bump" | "hold" | "ahead" | "declined" | "error";

export type ModelPlan = {
  id: string; // as the repo spells it
  lane: string | null;
  status: Status;
  target: string | null; // the selected model, spelled like `id`
  currentSlug: string | null; // `provider/model`, if known
  laneSlug: string | null;
  notes: string[];
  eval?: string;
};

export type Plan = { hash: string; errors: string[]; models: ModelPlan[] };

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/**
 * The first automatic lane that fits any of `slugs` (spellings the model could have as `provider/model`). A
 * lane with only an alias fits models in the same family as the alias's current target. Role-specific chains
 * require an explicit `lane:` assignment.
 */
export function inferLane(ids: string[], lanes: Record<string, LaneRule>, catalog: Catalog): string | null {
  const slugs = [...new Set(ids.flatMap((s) => [s, familyId(s)]))];
  for (const [name, rule] of Object.entries(lanes)) {
    const re = rule.match ? new RegExp(rule.match) : null;
    if (re && slugs.some((s) => re.test(s))) return name;
    const target = rule.alias && catalog.byId.get(rule.alias)?.alias_target?.slug;
    if (target && slugs.some((s) => s === target || (!re && familyPattern(target).test(s)))) return name;
  }
  return null;
}

/**
 * The ID without the suffixes that mark a snapshot of a family rather than a family of its own: dates
 * (-20250929, -2024-08-06, -0813, -02-15, Vertex's -001), -preview, -exp and -latest, repeatedly
 * (gemini-2.5-flash-preview-05-20 -> gemini-2.5-flash).
 */
export function familyId(id: string): string {
  const stripped = id.replace(/-(\d{4}-\d{2}-\d{2}|\d{8}|\d{2}-\d{2}|\d{3,4}|preview|exp|latest)$/, "");
  return stripped === id ? id : familyId(stripped);
}

/**
 * An ID the provider moves to its newest model itself, so there's nothing to upgrade: an OpenRouter `~` alias, a
 * versionless -latest (gemini-flash-latest, mistral-large-latest), or DeepSeek's own API names. claude-3-5-sonnet-latest
 * names a version, so it isn't one.
 */
export function isMovingAlias(id: string): boolean {
  const bare = id.replace(/^~/, "").replace(/^[\w-]+\//, "");
  return id.startsWith("~") || /^[a-z-]+-latest$/.test(bare) || ["deepseek-chat", "deepseek-reasoner"].includes(id);
}

/** Embedding models stay put unless the registry gives them a lane: a new one means re-embedding stored vectors. */
export const isEmbedding = (id: string) => /embed/i.test(id);

/**
 * How a model the catalog doesn't list (often a retired one) might be spelled as `provider/model`, so its lane
 * can still be inferred: the ID itself if it has a provider, else the ID under each provider in the catalog.
 */
function unlistedSlugs(id: string, catalog: Catalog): string[] {
  if (id.includes("/")) return [id];
  return [...new Set(catalog.models.map((m) => m.id.replace(/^~/, "").split("/")[0]))].map((p) => `${p}/${id}`);
}

export function planModel(m: Model, lanes: Record<string, LaneRule>, catalog: Catalog): ModelPlan {
  const cur = catalog.lookup(m.id);
  const format = m.format ?? inferFormat(m.id, cur?.id);
  const base = { id: m.id, eval: m.eval, target: null, laneSlug: null, currentSlug: cur?.id ?? (format === "openrouter" ? m.id : null) };
  const lane = m.lane ?? inferLane(cur ? [cur.id] : unlistedSlugs(m.id, catalog), lanes, catalog);
  if (m.hold) return { ...base, lane, status: "hold", notes: [`held: ${m.hold.trim()}`] };
  if (!m.lane && isEmbedding(m.id)) {
    return { ...base, lane, status: "hold", notes: ["held automatically: a new embedding model means re-embedding stored vectors; give it a `lane:` to upgrade it"] };
  }
  if (!m.lane && isMovingAlias(m.id)) {
    return { ...base, lane, status: "current", notes: ["a moving alias: the provider keeps it on its newest model"] };
  }
  if (!lane) {
    const why = cur ? "no built-in lane fits it" : "it isn't listed on OpenRouter or a provider API with a key set, and no lane fits its name";
    return { ...base, lane, status: "error", notes: [`${why}: give it a lane, or hold it`] };
  }
  const rule = lanes[lane];
  const resolved = catalog.resolveLane(rule, format === "openrouter");
  if ("error" in resolved) return { ...base, lane, status: "error", notes: [resolved.error] };

  const target = formatId(resolved.slug, format);
  const next = catalog.byId.get(resolved.slug) as OrModel;
  const notes: string[] = [];
  let status: Status = "bump";
  if (modelKey(m.id) === modelKey(resolved.slug) && target === m.id) status = "current";
  else if (!rule.chain && cur && newer(cur, next) >= 0) status = "ahead";
  if (status === "bump") {
    if (rule.chain) notes.push(`selected by the ${lane} chain (last entry, regardless of release date)`);
    notes.push([next.name, next.created && `released ${day(next.created)}`, next.source && `listed by the ${next.source}, not OpenRouter`].filter(Boolean).join(", "));
  }
  if (!cur) notes.push("current model isn't listed anymore (retired?)");
  if (cur?.expiration_date) notes.push(`current model expires on OpenRouter ${cur.expiration_date}`);
  return { ...base, lane, status, target, laneSlug: resolved.slug, notes };
}

export function planRepo(r: Registry, lanes: Record<string, LaneRule>, catalog: Catalog): Plan {
  const errors = lintRegistry(r, lanes);
  const models = errors.length ? [] : r.models.map((m) => planModel(m, lanes, catalog));
  // A registry has one entry per model ID. Don't merge a role's chain into another lane and lose its policy.
  const destinations = new Map<string, ModelPlan>();
  for (const m of models) {
    const id = m.status === "bump" ? m.target! : m.id;
    const other = destinations.get(id);
    if (other && other.lane !== m.lane &&
        ((other.lane && lanes[other.lane]?.chain) || (m.lane && lanes[m.lane]?.chain))) {
      errors.push(`${other.id} and ${m.id} would share ${id} but follow different lanes; one model ID cannot follow two lanes`);
    }
    destinations.set(id, m);
  }
  return { hash: planHash(models), errors, models };
}

/** Identifies a plan's set of moves, so a PR that already has them isn't redone. */
const planHash = (models: ModelPlan[]) =>
  createHash("sha256").update(models.filter((m) => m.status === "bump").map(move).sort().join("\n")).digest("hex").slice(0, 12);

/** A bump's move, as the repo spells it: "old=new". */
export const move = (m: ModelPlan) => `${m.id}=${m.target}`;

/** The plan with `change` applied to each model, and its hash recomputed. */
export function revise(plan: Plan, change: (m: ModelPlan) => ModelPlan): Plan {
  const models = plan.models.map(change);
  return { ...plan, models, hash: planHash(models) };
}

/** Marks bumps whose move is in `declined` (move -> the closed PR's number) as declined. */
export function decline(plan: Plan, declined: Map<string, number>): Plan {
  return revise(plan, (m) => m.status === "bump" && declined.has(move(m))
    ? { ...m, status: "declined", notes: [`declined: #${declined.get(move(m))} was closed without merging; a newer target will be proposed`] }
    : m);
}

const ICON: Record<Status, string> = { current: "✅", bump: "⬆️", hold: "⏸️", ahead: "✅", declined: "⏭️", error: "❌" };

export function renderPlan(plan: Plan): string {
  const out = ["### modelwatch plan", ""];
  for (const e of plan.errors) out.push(`- ❌ ${e}`);
  if (plan.models.length) {
    const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|");
    out.push("| | model | lane | target | notes |", "|---|---|---|---|---|");
    for (const m of plan.models) {
      out.push(`| ${ICON[m.status]} ${m.status} | \`${m.id}\` | ${m.lane ?? "—"} | ${m.target && m.target !== m.id ? `\`${m.target}\`` : ""} | ${cell(m.notes.join("; "))} |`);
    }
  }
  return out.join("\n") + "\n";
}
