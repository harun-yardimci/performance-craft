# Using performance-craft with Codex

The repository is also a [Codex plugin](https://developers.openai.com/codex/plugins/build). Codex reads the same `skills/performance-craft` folder that Claude Code uses; nothing is copied.

## Install

```bash
codex plugin marketplace add harun-yardimci/performance-craft
```

Requires Codex CLI v0.122 or later (older releases used `codex marketplace add`). A local clone works too: `codex plugin marketplace add /path/to/performance-craft`. Restart Codex if it is already running.

Manual alternative, without the plugin system:

```bash
git clone https://github.com/harun-yardimci/performance-craft.git
cp -R performance-craft/skills/performance-craft ~/.agents/skills/
```

## Setup for the lab audit

The static scanner and `field_data.mjs` need only Python 3 / Node. The browser audit needs its dependency once:

```bash
cd ~/.codex/plugins/performance-craft/skills/performance-craft/scripts && npm install
```

(adjust the path for a manual install). It drives the Chrome or Edge already on the machine; nothing is downloaded.

## Usage

Invoke it with `$performance-craft` or `@performance-craft`, or describe the problem ("the product page is slow on mobile", "GET /orders takes 3 seconds") and let Codex pick the skill. `agents/openai.yaml` provides the display name and default prompt in the Codex UI.

## How it works

- `codex/.codex-plugin/plugin.json`: the Codex plugin manifest; `skills` points at `./skills/`.
- `codex/skills`: a git-tracked symlink to `../skills`, so the plugin directory is self-contained without duplicating files. Codex requires plugins to live in a subdirectory of the marketplace root.
- `.agents/plugins/marketplace.json`: the marketplace entry pointing at `./codex`.

On Windows, or if symlinks are not available, replace the symlink with a copy after cloning (`rm codex/skills && cp -R skills codex/skills`). Keep that change local.
