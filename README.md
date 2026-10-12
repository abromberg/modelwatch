<img src="docs/assets/modelwatch.png" alt="A clay owl perched on a Git branch" width="160" />

# modelwatch

**Dependabot for LLM model strings.**

modelwatch keeps your model strings up to date with the latest and greatest. When a new version of a model
comes out (e.g. Sonnet 5 to Sonnet 5.5), modelwatch opens a pull request to upgrade it in your codebase,
including intelligently handling anything adjacent — pricing entries, test assertions, display names, request
settings, and so on.

It runs weekly (or whatever) in GitHub Actions, through a GitHub App you own, from a version of modelwatch
you pin and upgrade on your own schedule. You choose which repos and models it watches. The agent harness is
[Pi](https://pi.dev), using a model you choose and pay for through [OpenRouter](https://openrouter.ai) (GLM's
latest Flash by default), with Zero Data Retention (ZDR) routing required.

[Setup](#setup) · [Configuration](#configuration) · [Day to day](#day-to-day-tips) · [Updating](#updating-modelwatch) · [Security](#security)

## How it works

1. **Find the models.** On its first run in a repo, the agent finds the model IDs in use and opens a
   configuration PR which adds `.github/modelwatch.yml`, a short list of models to watch. Review and merge it
   to opt in.
2. **Watch for releases.** By default, modelwatch checks that list every Monday for newer models in the same
   family: Sonnet follows Sonnet, Gemini Flash follows Gemini Flash. These families are called _lanes_; the
   defaults are in [lanes.yaml](lanes.yaml). You can also define your own lane for a role like
   "title-generator" or "decision-model" and list a chain of models you've chosen. The last entry is the
   target, even if it's an older release or a different family. [Custom chains](#choose-your-own-upgrade-path)
   are optional and specific to your repo; modelwatch doesn't choose those preferences for you.
3. **Open an upgrade PR.** When an update is available, the agent edits the code and writes notes for the
   reviewer. modelwatch groups the upgrades into one PR per repo and updates `modelwatch.yml` along with them.
   Close a PR without merging to decline those upgrades, as with Dependabot: modelwatch proposes the model
   again only once there's a newer one.

For example, a Sonnet upgrade might change an API call, update a test that asserts the model name, and add an
entry to your pricing table. The PR explains changes beyond the ID swap and flags anything uncertain. If
modelwatch's checks find a missing new ID, a change to an ignored path, or files the agent added, a new PR
opens as a draft, and the next runs retry it (up to 3 runs in all).

If modelwatch can't plan a model (say, it's no longer listed anywhere and has no lane), it keeps upgrading the
others and lists that model under **Fix in `.github/modelwatch.yml`** in the PR. Either way, the run fails
for that repo until the file is fixed, so you hear about it even when there's no PR to put it in.

## Setup

You'll need:

- **The [GitHub CLI](https://cli.github.com)**, logged in with permission to add workflow files:
  `gh auth login`, then `gh auth refresh -s workflow`
- **An [OpenRouter API key](https://openrouter.ai/settings/keys)** with some credit on it
- **Node 22.19 or newer**

### 1. Run the setup script

```sh
git clone https://github.com/abromberg/modelwatch
cd modelwatch
npm ci
node src/setup.ts
```

For a GitHub organization, use `node src/setup.ts --org your-org` instead; you must be an organization owner.
If you cloned a fork, the runner runs your fork.

The script:

- creates a private repo, `<owner>/modelwatch-runner`, containing
  [the weekly workflow](runner/modelwatch.yml), pinned to the current modelwatch commit (see
  [Updating modelwatch](#updating-modelwatch))
- opens your browser to create your modelwatch GitHub App: then you just click **Create GitHub App** and
  return to the terminal
- saves the App's credentials as secrets on the runner repo

Running it again is safe: it keeps an existing workflow and App.

Add your OpenRouter key when setup finishes. This command prompts for it:

```sh
gh secret set OPENROUTER_API_KEY -R <owner>/modelwatch-runner
```

If `OPENROUTER_API_KEY` is already set in your environment, the setup script saves it for you. Replace
`<owner>` in these commands with your GitHub username or organization.

### 2. Install the App and preview a run

The script prints a link at the end (it's also under **Settings → Developer settings → GitHub Apps → your
modelwatch App → Install App**). Pick the repos to watch, or all of them.

Then start a dry run:

```sh
gh workflow run modelwatch.yml -R <owner>/modelwatch-runner -f dry-run=true
```

Open the runner repo's **Actions** tab and read the completed run's summary to see the proposed PRs. A dry run
still runs the agent and uses OpenRouter credit; it just doesn't push branches or open PRs.

### 3. Turn it on

Run it without the dry-run flag, or wait for Monday's scheduled run:

```sh
gh workflow run modelwatch.yml -R <owner>/modelwatch-runner
```

Each newly installed repo gets a **Configure modelwatch** PR. Check the model list, edit anything that's off,
and merge. Subsequent runs open upgrade PRs when newer models are available.

To add a repo later, install the App on it. The next run sends it a Configure PR.

## Configuration

`.github/modelwatch.yml` tells modelwatch which models to watch. The Configure PR writes it for you, but you
can also write or edit it by hand. Use model IDs exactly as they appear in your code:

```yaml
models:
  - claude-sonnet-5
  - gemini-3.8-flash
```

modelwatch works out the rest: which family each model belongs to, and whether your code writes IDs
OpenRouter's way (`anthropic/claude-sonnet-5.5`) or the provider's way (`claude-sonnet-5-5`). Each upgrade PR
updates this file to the new IDs.

A few optional extras cover the common cases:

```yaml
models:
  - claude-sonnet-5
  - id: text-embedding-3-small
    hold: stored vectors are 1536-dim; a new model needs a re-index # hold = never upgrade this one

notes: > # tips for the agent, e.g. per-model lists it should update
  Add new models to src/pricing.ts.

after_merge: # a checklist added to every upgrade PR
  - Set CHAT_MODEL in production to <new>, then redeploy.

ignore: # paths to leave alone: folders or files, not globs
  - test/fixtures/
```

Unknown keys are errors rather than ignored, so a typo like `holds:` can't let a pinned model move.

The [configuration reference](docs/registry.md) covers every option, including custom lanes and per-model eval
commands. Eval commands become checklist items for the reviewer; modelwatch doesn't run them.

### Choose your own upgrade path

Add a named lane with a `chain` and assign a model to it. Other models can keep following the built-in lanes:

```yaml
models:
  - claude-sonnet-5 # follows new Sonnet releases as usual
  - id: openai/gpt-6-luna
    lane: title-generator

lanes:
  title-generator:
    chain:
      - openai/gpt-6-luna
      - google/gemini-3.8-flash
```

Here, modelwatch proposes moving the title generator to Gemini Flash because it's last in your chain. Append
another model when you pick a new favorite. A repo that's several entries behind moves straight to the last
entry in one PR; release dates don't affect the choice. The lane assignment stays in the config after each
upgrade. `hold` still keeps a model pinned.

Chain entries use full `provider/model` IDs, and the target must be in a catalog modelwatch can access. Assign
the chain explicitly with `lane:`; defining it alone doesn't change how other models are watched. Each model
ID has one registry entry, so separate roles using the same ID can't follow different lanes.

### Preview your configuration

To check a local repo's configuration and see planned upgrades without running the agent:

```sh
node path/to/modelwatch/src/main.ts --plan --dir path/to/your-repo
```

This reads the public model catalog over the network. No API key is required, and it doesn't edit files or
open PRs.

### Check providers directly

By default, modelwatch checks OpenRouter's public model list. To also check a provider's own catalog, add its
key as a secret on the runner repo:

```sh
gh secret set ANTHROPIC_API_KEY -R <owner>/modelwatch-runner
gh secret set OPENAI_API_KEY -R <owner>/modelwatch-runner
gh secret set GEMINI_API_KEY -R <owner>/modelwatch-runner
```

These optional keys are used only to list models. They let modelwatch discover releases before OpenRouter
lists them, or models it doesn't carry. IDs written in OpenRouter format still follow OpenRouter's catalog.

### Choose the agent's model

The default is `~z-ai/glm-flash-latest`. To use another model for a repo, set `agent_model` in its
`.github/modelwatch.yml` to an OpenRouter model ID or `~...-latest` alias. To override it for a single run,
use the **Run workflow** form in the runner repo.

## Day to day tips

- **Run it now, or for some repos only:** in the runner repo, go to **Actions → modelwatch → Run workflow**.
  The form also lets you do a dry run or try a different agent model.
- **A PR's CI fails:** push a fix to the PR branch like any other PR. Once someone else has pushed to it,
  modelwatch leaves that branch alone.
- **Don't want an upgrade:** close its PR. modelwatch won't propose that same move again, only a newer
  target. To get it back, reopen the PR.
- **Stop watching a repo:** remove it from the App installation. You can also close its Configure PR, or
  delete its `.github/modelwatch.yml` after merging that PR; modelwatch won't open another Configure PR.
- **Never upgrade a particular model:** add `hold:` with a reason (see above).

To resume after closing a Configure PR or removing the configuration, restore or add `.github/modelwatch.yml`
and make sure the App is installed.

## Updating modelwatch

The runner's workflow runs modelwatch from a fixed commit, for example
`uses: abromberg/modelwatch@68c2693… # main`, not from a branch. modelwatch's code reads your App's private
key, so new code from its repo reaches your runner only when you choose to upgrade. To upgrade, pull this
repo and run:

```sh
git pull
node src/setup.ts --upgrade   # add --org your-org for an organization
```

It shows the changes since your pinned commit and the diff to the runner workflow, then moves the pin and
refreshes the workflow file after you confirm. It keeps your schedule but replaces other edits to that file.
Without `--ref`, it picks the latest release, or the newest commit on the default branch if there are no
releases. `--ref <tag or commit>` pins a specific version.

I don't promise to keep modelwatch up to date (though I'll likely do a decent job), so you may prefer a
fork. Clone your fork and run setup from it; the runner will run the fork, and `--upgrade` follows the fork.
To move an existing runner to a fork, use `--upgrade --from you/modelwatch`.

If your runner predates pinning (its workflow says `@main`), run `--upgrade` once. That also moves it to one
job per repo.

## Security

- **The App** can write code, workflow files, and PRs in the repos you select. modelwatch commits only
  to its own `modelwatch/` branches, through GitHub's API, so the commits are signed by the App. The App's
  private key is stored in your runner repo's secrets; modelwatch creates a separate token scoped to each repo
  and doesn't pass the key or tokens to the agent, or to any program after the agent has run.
- **The code that holds the key** is the modelwatch commit your runner is pinned to. It changes only when you
  [upgrade](#updating-modelwatch). Review the changes when you do, or run your own fork.
- **The agent** reads repository content that may contain malicious instructions. Each repo is checked in its
  own job on a fresh machine, so an agent never sees another repo's checkout. On GitHub-hosted runners, the
  workflow restricts sudo and Docker access before the agent starts.
- **Your code's privacy:** the agent sends repository context through OpenRouter and receives your OpenRouter
  key. modelwatch requests [Zero Data Retention routing](src/zdr.ts) on every model request; if no eligible
  provider is available, the request is refused. ZDR covers the model requests only: the agent has a shell
  with network access, so a repo with malicious instructions could still try to send its code somewhere
  else. App credentials and optional provider keys stay with the parent process.
- **Keep the runner repo private.** Its logs include output from the repos modelwatch works on.

## Limits

- **Newer doesn't always mean better for your app.** Review behavior changes and run your evals before
  merging. Set `eval` on a model in your repo config to add a command to the PR's review checklist. Run it
  yourself or in CI; modelwatch doesn't run evals or use their results to decide upgrades.
- modelwatch leaves the full test suite to your CI. The agent may run a quick targeted check.
- When a model is discovered through OpenRouter, modelwatch derives its provider-native spelling rather than
  confirming it with the provider. CI or a reviewer needs to catch a mismatch.
- The Gemini API doesn't publish release dates, so for Gemini models only it lists, the highest version number
  counts as newest.
- Built-in families cover chat and image models. Embedding models are held automatically. For others, add
  your own under `lanes:`, or `hold:` the model.
- IDs are understood in OpenRouter's spelling (`anthropic/claude-sonnet-5.5`) or the provider's
  (`claude-sonnet-5-5`). Cloud-platform IDs such as Bedrock's `anthropic.claude-sonnet-5-v1:0`, Vertex's
  `claude-sonnet-5@20260301` or Azure deployment names aren't, so `hold:` those.
- One run checks up to 256 repos (GitHub's limit on jobs per matrix), 4 at a time. Change `max-parallel` in
  the runner workflow to run more at once.

## Contributing

To work on modelwatch itself, clone the repo, run `npm ci`, then `npm test`. Tests live in
[src/modelwatch.test.ts](src/modelwatch.test.ts) and [src/chains.test.ts](src/chains.test.ts). Model families
are defined in [lanes.yaml](lanes.yaml); configuration options are documented in
[docs/registry.md](docs/registry.md).

## Badge and automation

To show that a repo uses modelwatch, add this to its README:

```markdown
[![modelwatch](https://img.shields.io/badge/modelwatch-enabled-2f6feb)](https://github.com/abromberg/modelwatch)
```

Upgrade PR descriptions end with a hidden line like
`<!-- modelwatch-bumps: anthropic/claude-sonnet-5=anthropic/claude-sonnet-5.5 -->`, for anything you want to
trigger when one merges.

## License

[MIT](LICENSE)
