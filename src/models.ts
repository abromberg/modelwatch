import type { LaneRule } from "./registry.ts";

export type OrModel = {
  id: string;
  canonical_slug?: string;
  name: string;
  created: number; // 0 when unknown
  expiration_date?: string | null;
  pricing?: { prompt: string; completion: string; [k: string]: string };
  alias_target?: { slug: string; name: string } | null;
  source?: string; // set on models only a provider's own API lists, e.g. "Anthropic API"
};

/** OpenRouter's public model catalog. */
export async function fetchModels(): Promise<OrModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter /models: HTTP ${res.status}`);
  return (await res.json()).data;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

export type ProviderKeys = { anthropic?: string; openai?: string; gemini?: string };

// The providers' own model lists. IDs are spelled `provider/model`, like OpenRouter's.
const PROVIDERS: Record<keyof ProviderKeys, [string, (key: string) => Promise<Omit<OrModel, "source">[]>]> = {
  anthropic: ["Anthropic API", async (key) => {
    const out = [];
    for (let after = ""; ;) {
      const page = await getJson(`https://api.anthropic.com/v1/models?limit=1000${after && `&after_id=${after}`}`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" });
      out.push(...page.data.map((m: any) => ({ id: `anthropic/${m.id}`, name: m.display_name, created: Math.floor(Date.parse(m.created_at) / 1000) || 0 })));
      if (!page.has_more) return out;
      after = page.last_id;
    }
  }],
  openai: ["OpenAI API", async (key) => {
    const page = await getJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${key}` });
    return page.data.filter((m: any) => !m.id.includes(":")) // fine-tunes
      .map((m: any) => ({ id: `openai/${m.id}`, name: m.id, created: m.created ?? 0 }));
  }],
  gemini: ["Gemini API", async (key) => {
    const out = [];
    for (let token = ""; ;) {
      const page = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${token && `&pageToken=${token}`}`,
        { "x-goog-api-key": key });
      // No release dates in this API; newer() falls back to the version in the ID.
      out.push(...page.models.map((m: any) => ({ id: m.name.replace(/^models\//, "google/"), name: m.displayName, created: 0 })));
      if (!page.nextPageToken) return out;
      token = page.nextPageToken;
    }
  }],
};

/** Models from the providers' own APIs, for each key given. A provider that fails is skipped with a warning. */
export async function fetchProviderModels(keys: ProviderKeys): Promise<OrModel[]> {
  const lists = await Promise.all((Object.keys(PROVIDERS) as (keyof ProviderKeys)[]).filter((p) => keys[p]).map(async (p) => {
    const [source, list] = PROVIDERS[p];
    try {
      const models = (await list(keys[p]!)).map((m) => ({ ...m, source }));
      console.log(`${source}: ${models.length} models`);
      return models;
    } catch (e) {
      console.log(`::warning::${source} model list failed (${(e as Error).message}); using OpenRouter's list alone for it`);
      return [];
    }
  }));
  return lists.flat();
}

/** Spelling-insensitive key: "anthropic/claude-sonnet-4.6" and "claude-sonnet-4-6" collide on purpose. */
export function modelKey(id: string): string {
  return id.toLowerCase().replace(/^~/, "").replace(/^[\w-]+\//, "").replace(/\./g, "-");
}

const byVersion = (a: OrModel, b: OrModel) => a.id.localeCompare(b.id, "en", { numeric: true });

/** Positive if a is newer than b: by release date, or by the version in the ID when either date is unknown. */
export function newer(a: OrModel, b: OrModel): number {
  return a.created && b.created ? a.created - b.created : byVersion(a, b);
}

/**
 * The newest of `ms`: by release date when every one has a date, otherwise all by the version in the ID. (Mixing
 * the two per pair, as `newer` does, isn't a consistent order to sort by.)
 */
export function newest(ms: OrModel[]): OrModel | undefined {
  const dated = ms.every((m) => m.created);
  return [...ms].sort((a, b) => (dated ? b.created - a.created : byVersion(b, a)))[0];
}

/**
 * IDs in the same family as `slug`, any version: x-ai/grok-5 gives ^x-ai/grok-\d+([.-]\d+)*$, which also
 * matches x-ai/grok-4 and x-ai/grok-4.1 but not x-ai/grok-4-fast. For alias lanes without a `match`.
 */
export function familyPattern(slug: string): RegExp {
  const parts = slug.split(/\d+(?:[.-]\d+)*/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("\\d+(?:[.-]\\d+)*")}$`);
}

export class Catalog {
  readonly byKey = new Map<string, OrModel>();
  readonly byId = new Map<string, OrModel>();
  readonly models: OrModel[];
  // No parameter properties: Node's type stripping doesn't support them.
  /** `direct` are provider-API models; any OpenRouter also lists is dropped in favor of OpenRouter's richer entry. */
  constructor(models: OrModel[], direct: OrModel[] = []) {
    const keys = new Set(models.flatMap((m) => [m.canonical_slug, m.id]).filter((k): k is string => !!k).map(modelKey));
    this.models = [...models, ...direct.filter((m) => !keys.has(modelKey(m.id)))];
    for (const m of this.models) {
      this.byId.set(m.id, m);
      // Variants (:free, :batch) share their model's canonical slug, so they never claim a key.
      if (!m.id.includes(":")) for (const k of [m.canonical_slug, m.id]) if (k) this.byKey.set(modelKey(k), m);
    }
  }

  /** Finds a pinned ID however the repo spells it (OpenRouter slug, native, prefixed-native). */
  lookup(id: string): OrModel | undefined {
    return this.byId.get(id) ?? this.byKey.get(modelKey(id));
  }

  /**
   * The lane's target, as a `provider/model` ID, or an error string. A chain selects its last entry, without
   * comparing release dates or falling back to an earlier entry. An alias lane follows OpenRouter's
   * alias, unless a provider's own API lists a newer model matching the lane's `match`. A match-only lane takes
   * the newest match. `openrouterOnly` is for pins that call OpenRouter, which can only use what it lists.
   */
  resolveLane(rule: LaneRule, openrouterOnly = false): { slug: string } | { error: string } {
    if (rule.chain) {
      const id = rule.chain.at(-1)!;
      const target = this.byId.get(id);
      if (!target || (openrouterOnly && target.source)) {
        return { error: `chain target ${id} isn't listed ${openrouterOnly ? "on OpenRouter" : "on OpenRouter or a provider API with a key set"}` };
      }
      return { slug: target.id };
    }
    const re = rule.match ? new RegExp(rule.match) : null;
    const matches = re ? this.models.filter((m) => re.test(m.id) && !(openrouterOnly && m.source)) : [];
    if (rule.alias) {
      const target = this.byId.get(this.byId.get(rule.alias)?.alias_target?.slug ?? "");
      if (!target) return { error: `alias ${rule.alias} not found on OpenRouter` };
      return { slug: newest([target, ...matches.filter((m) => m.source)])!.id };
    }
    if (re) {
      const m = newest(matches);
      return m ? { slug: m.id } : { error: `no listed model matches ${rule.match} (for a model only a provider's API lists, set that provider's key)` };
    }
    return { error: "lane needs alias or match" };
  }
}
