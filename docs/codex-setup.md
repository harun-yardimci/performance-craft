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
cd ~/.codex/plugins/cache/performance-craft/performance-craft/*/skills/performance-craft/scripts && npm install
```

Codex caches plugins under `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`; adjust the path for a manual install. It drives the Chrome or Edge already on the machine; nothing is downloaded.

## Usage

Invoke it with `$performance-craft` or `@performance-craft`, or describe the problem ("the product page is slow on mobile", "GET /orders takes 3 seconds") and let Codex pick the skill. `agents/openai.yaml` provides the display name and default prompt in the Codex UI.

## How it works

- `.codex-plugin/plugin.json` at the repository root: the Codex plugin manifest; `skills` points at `./skills/`, the same folder Claude Code reads.
- `.agents/plugins/marketplace.json`: the marketplace entry. Its `source.path` is `./`, so the repository root is the plugin root, and `installation` is `INSTALLED_BY_DEFAULT`, so `codex plugin marketplace add` installs the plugin in one step. If it is listed but not active, run `codex plugin add performance-craft@performance-craft` or use `/plugins` in Codex.

No symlinks are involved, so the layout works the same on Windows.
