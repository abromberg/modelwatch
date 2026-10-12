# Registry format

`.github/modelwatch.yml` lists the LLM models a repo uses that modelwatch should keep current. Usually that's
all it needs:

```yaml
models:
  - anthropic/claude-sonnet-5 # spelled exactly as in the code
  - gemini-3.8-flash
```

modelwatch infers each model's lane (which line of models it follows, from [lanes.yaml](../lanes.yaml)) and
how the repo spells IDs. When a newer model is out, it finds every use of the old ID in the repo and hands
them to the agent, which makes the change. Each bump PR also updates this file to the new IDs.

You can also assign a model to an optional [custom chain](#custom-chains): your chosen sequence of models,
independent of release dates. These choices live in your repo's configuration and don't affect other users.

Everything else is optional:

```yaml
models:
  - anthropic/claude-sonnet-5
  - id: text-embedding-3-small
    hold: stored vectors are vector(1536); a new model needs a re-index # never bump, and why
  - id: openai/gpt-oss-120b
    lane: openai-luna # when no lane fits it by name
  - id: openai/gpt-6-luna
    eval: npm run eval -- --model <new> # the PR asks for this before merging

notes: > # for the agent: gotchas the next bump must know, one line each
  The summarizer sends max_tokens 500; a thinking model can spend it all. Add new models to src/pricing.ts.

after_merge: # the PR's after-merge checklist; <old> and <new> are filled in
  - Set CHAT_MODEL in production to <new> if it's <old>, then redeploy.

ignore: # paths whose model IDs must never change, e.g. test fixtures: a folder or a file, not a glob
  - test/fixtures/

lanes: # extra lanes, or overrides of built-in ones by name
  openai-realtime: { match: '^openai/gpt-realtime-\d+(\.\d+)?$' } # needs OPENAI_API_KEY on the runner
agent_model: ~anthropic/claude-sonnet-latest # OpenRouter model or ~alias for the agent
```

Any other key is an error, so a misspelling (`holds:`, `after-merge:`) is caught instead of silently
ignored. Models modelwatch can't plan are listed in the bump PR and fail the run until they're fixed;
models without problems keep being upgraded.

A model doesn't have to be listed anywhere to keep its lane: one that has been retired is placed by its
name (`claude-sonnet-4-5` still follows `anthropic-sonnet`) and moves to the lane's newest model. Dates and
`-preview`, `-exp` or `-latest` suffixes don't change the lane: `claude-sonnet-4-5-20250929`,
`gemini-3-flash-preview` and `gpt-4o-2024-08-06` follow `anthropic-sonnet`, `gemini-flash` and `openai-gpt`.

Some IDs need no upgrades and never get one:

- **Moving aliases** the provider keeps on its newest model, like `gemini-flash-latest`,
  `mistral-large-latest`, `~anthropic/claude-sonnet-latest` or DeepSeek's `deepseek-chat`, are always current.
  An alias that names a version, like `claude-3-5-sonnet-latest`, isn't one, and it moves like any other model.
- **Embedding models** (any ID containing `embed`) are held automatically, since a new one means re-embedding
  stored vectors. Give one a `lane:` to upgrade it anyway.

A model can also take `format:` (`openrouter`, `native` or `prefixed-native`) if modelwatch infers the
spelling wrong: `anthropic/claude-sonnet-5.5` (OpenRouter), `claude-sonnet-5-5` (Anthropic's own), or
`anthropic/claude-sonnet-5-5` (prefixed). A model in the OpenRouter spelling only moves to models OpenRouter
lists.

## Custom chains

A lane with `chain:` follows your preferences instead of release dates. Name it for whatever role you need,
and explicitly assign the model to it with `lane:`:

```yaml
models:
  - id: openai/gpt-6-luna
    lane: decision-model

lanes:
  decision-model:
    chain:
      - openai/gpt-6-luna
      - google/gemini-3.8-flash
      - anthropic/claude-sonnet-5.5
```

The last entry is the desired target. This proposes moving directly from GPT to Sonnet, skipping intermediate
entries. The order is yours: the target can be older than the current model, from another family, or a return
to a model used earlier. Append your next choice when you're ready. The explicit `lane:` assignment is kept
after upgrades, and `hold:` still prevents changes. A single-entry chain is also valid when you only want to
name the desired target; the current model doesn't have to appear earlier in the list.

- Use a non-empty list of full `provider/model` IDs exactly as listed in the catalog. Chain entries are
  concrete model IDs, not `~...-latest` aliases. A chain cannot also have `alias:` or `match:`.
- Only the final target must still be listed; historical entries can be retired. An unavailable target
  produces an error instead of falling back to another entry. OpenRouter-formatted IDs require a target listed
  by OpenRouter; native IDs can also use the supported provider catalogs when their keys are set.
- modelwatch converts the target to your repo's ID format, just as it does for automatic lanes. Changing
  providers also requires compatible API calls and credentials; review the resulting PR for those changes.
- Chains require an explicit `lane:` assignment and aren't inferred from model IDs. Declaring a chain doesn't
  change the automatic lanes used by other models.
- Registry entries track model IDs across the repo, not individual call sites. The same ID can't have one lane
  for title generation and another for decisions. If different lanes would converge on the same ID, modelwatch
  reports an error so it doesn't silently discard either lane.

For automatic upgrades, keep using the built-in lanes or define a lane with `alias:` and/or `match:`. Those
lanes still select newer releases and won't move to an older model.

## Declining an upgrade

Closing a bump PR without merging declines the moves it proposed. modelwatch won't propose the same
old → new move again, only a newer target. Reopen the PR to bring it back, or `hold:` the model to stop
upgrades altogether.

## Post-merge automation

PR bodies end with `<!-- modelwatch-bumps: old=new,... -->` for automation that runs on merge. Its IDs are
`provider/model` slugs whatever the repo's spelling; a model OpenRouter no longer lists is left out.
