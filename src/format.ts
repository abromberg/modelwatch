import type { Format } from "./registry.ts";

/** Converts a lane's `provider/model` ID into the spelling the repo uses. */
export function formatId(slug: string, format: Format): string {
  const [provider, model] = slug.split("/", 2);
  // Anthropic's native IDs use dashes in versions: claude-sonnet-5.5 -> claude-sonnet-5-5.
  const native = provider === "anthropic" ? model.replace(/\./g, "-") : model;
  if (format === "native") return native;
  if (format === "prefixed-native") return `${provider}/${native}`;
  return slug;
}

/**
 * How the repo spells a model, from the ID itself: no prefix is native (claude-sonnet-5-5), and a prefixed
 * Anthropic ID with dashed versions that isn't OpenRouter's own slug is prefixed-native (anthropic/claude-sonnet-5-5).
 */
export function inferFormat(id: string, slug?: string): Format {
  if (!id.includes("/")) return "native";
  if (id === slug || !id.startsWith("anthropic/")) return "openrouter";
  return /\d-\d/.test(id) ? "prefixed-native" : "openrouter";
}
