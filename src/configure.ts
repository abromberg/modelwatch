// Setting up a repo that has no registry: the agent drafts .github/modelwatch.yml, and the App opens a
// "Configure modelwatch" PR. Merging it turns modelwatch on; closing it means modelwatch never asks again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPlan, type Plan } from "./plan.ts";
import { DOCS_URL, HOME, LANES_TEXT, REGISTRY, REPO_URL, badge, footer, type Registry } from "./registry.ts";

export const CONFIGURE_BRANCH = "modelwatch/configure";

export function configurePrompt(repo: string): string {
  return [
    `You are setting up modelwatch for ${repo}. modelwatch keeps the LLM models a repo uses current: on a schedule it`,
    `checks for newer models and opens PRs that move them. It only touches models listed in ${REGISTRY}.`,
    "Your job: write that file. A human reviews it in a PR. Keep it short: usually just the list of models.",
    "",
    "## Steps",
    "1. Find every LLM model ID the repo uses live: API calls, config, env defaults (.env.example), workflow files.",
    "   Search for provider and model-family names (claude, gpt-, o3, o4, gemini, grok, llama, mistral, deepseek,",
    "   glm, qwen) and for `model`. Skip docs, changelogs, catalogs or price tables listing many models, fixtures,",
    "   and migrations.",
    "2. List each distinct ID once under `models`, spelled exactly as in the code. modelwatch infers which lane",
    "   (built-in lanes below) each follows; give `lane:` only when none fits by name, and leave a model out if no",
    "   lane fits it at all.",
    "   Custom chains are choices for the repo owner; don't invent a chain or a preference between model families.",
    "3. Add `hold:` with a one-sentence reason where a newer model would break something: fine-tunes, a model an eval",
    "   picked. Embedding models are held automatically, so list them without `hold:` unless the reason is specific.",
    "4. Only if they apply: `notes` for gotchas the next bump must know (one line each, e.g. a token limit a thinking",
    "   model could exhaust, or per-model lists that need the new model added), `after_merge` for steps outside the",
    "   repo the code shows (hosting env vars, database rows), and `ignore` for paths whose model IDs are sample data.",
    "If the repo uses no LLM model IDs, write a file with only a comment saying so and `models: []`.",
    "",
    "## Rules",
    `- Create or edit only ${REGISTRY}.`,
    "- Don't install dependencies, build, or run anything that needs secrets.",
    "",
    "## Your final message",
    "It becomes part of the PR description. Write markdown under one heading, `### What I found`: short bullets on",
    "where each model is used, anything you left out and why, and anything a human should double-check.",
    "",
    "## Registry format",
    readFileSync(join(HOME, "docs/registry.md"), "utf8"),
    "## Built-in lanes (lanes.yaml)",
    "```yaml",
    LANES_TEXT,
    "```",
  ].join("\n");
}

export function configureBody(r: Registry | null, plan: Plan | null, problems: string[], agentNotes: string, stats: string): string {
  const out = [
    badge("configure"),
    "",
    `[modelwatch](${REPO_URL}) keeps this repo's LLM models current: when a newer version of a model listed in`,
    `\`${REGISTRY}\` is out, it opens a PR that moves it, with the code changes the new model needs.`,
    "",
    `- **Merge** to turn it on. Edit the file first if anything's wrong ([format](${DOCS_URL})).`,
    "- **Close** to turn it off for this repo. modelwatch won't ask again.",
    "",
  ];
  if (r && !r.models.length) out.push("No LLM model IDs were found, so there's nothing to watch. Merging or closing both stop modelwatch from scanning again.", "");
  if (problems.length) out.push("> [!WARNING]", "> Draft: the registry has problems to fix before merging.", ...problems.map((p) => `> - ${p}`), "");
  if (plan?.models.length) out.push(renderPlan(plan).replace(/^### modelwatch plan/, "### What modelwatch will watch"));
  out.push(agentNotes.trim(), "", footer(stats));
  return out.join("\n");
}
