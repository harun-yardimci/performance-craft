# Using performance-craft with Gemini CLI

The repository is also a [Gemini CLI extension](https://geminicli.com/docs/extensions/). Gemini auto-discovers the `skills/` folder bundled with the extension; the skill file is the same one Claude Code and Codex read.

## Install

```bash
gemini extensions install https://github.com/harun-yardimci/performance-craft
```

Installing from the GitHub URL takes the **latest GitHub release**, not `main`: Gemini downloads the tagged source archive and records the tag, and `gemini extensions update` moves to the next release. To track `main` instead, install from a clone: `gemini extensions install /path/to/performance-craft`. Restart Gemini CLI if it is already running.

## Setup for the lab audit

```bash
cd ~/.gemini/extensions/performance-craft/skills/performance-craft/scripts && npm install
```

The static scanner and `field_data.mjs` need no setup.

## Usage

Describe the problem ("Core Web Vitals are failing on mobile", "the app takes four seconds to open") and the skill activates when the request matches its description.

## Workspace mode

Running Gemini CLI from inside a clone of this repository loads the skill as a workspace skill through the `.gemini/skills` symlink, without a global install.

## How it works

- `gemini-extension.json`: the extension manifest at the repository root.
- Releases carry two assets: `performance-craft.zip` (the bare skill folder, for uploading to Claude apps) and `performance-craft-extension.zip` (the whole repository). This is deliberate: when a release has exactly one asset without a platform name, Gemini treats that asset as the extension itself; the bare skill zip has no `gemini-extension.json` at its root, so the install fails with `Configuration file not found`. With two assets Gemini falls back to the tagged source archive, which is the extension. Keep both assets on every release.
- `.gemini/skills`: a git-tracked symlink to `../skills` for workspace mode. On Windows, replace it with a copy after cloning (`rm .gemini/skills && cp -R skills .gemini/skills`) and keep that change local.
