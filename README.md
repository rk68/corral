# Herdr config

My mods, layouts, themes and key bindings for the Herdr desktop app.

## Mods

| Mod | What it does |
|---|---|
| `agent-flow` | A live view of the agents in a space: who delegated what, their states, a map, a timeline, context size, lanes, and cost per agent with cache health and a stuck-agent check. |
| `agent-plans` | Each agent's plan in the right panel. `hook/plan.py` connects to Claude Code and Codex hooks. |
| `pr-stack` | Your open pull requests in merge order, what blocks each one, one-click fixes, agents that resolve conflicts or fix CI, merging a whole stack, and the trunk's CI and deploy status. |
| `pr-diff` | One pull request's diff in a pane, with GitHub's "Viewed" box on each file. Open it from the file counts on a `pr-stack` row. |
| `contributions` | Your GitHub contribution calendar, private work included, in a pixel style. Below 300 px tall it shows only the squares. |
| `usage` | Claude Code and Codex plan limits in the sidebar. |
| `my-files` | A file browser for the focused pane's folder. |
| `herdr-md` | A Markdown viewer pane with highlights and notes. `mdh` drives it from a shell. |

The layout `herdr-usage` places these mods. `glacier` is the theme.

`herdr-core/templates/` holds the `hc` agent templates (`advisor`, `advisor-codex`, `reviewer`) that the Herdr skills in [rk68/skill-suite](https://github.com/rk68/skill-suite) start.

## Install

The mods need Node.js 18 or later, and `gh` signed in to GitHub. `pr-stack` also uses `git` and `hc`.

1. Copy the folders into the app's config folder:

   ```sh
   rsync -a mods/ ~/.config/herdr-app/mods/
   rsync -a layouts/ ~/.config/herdr-app/layouts/
   rsync -a themes/ ~/.config/herdr-app/themes/
   ```

2. Merge `keys.json` and `settings.json` into your own by hand. A copy replaces your bindings.
3. For the `usage` mod, copy `claude/statusline-usage.sh` to `~/.claude/` and set it as the Claude Code status line:

   ```json
   { "statusLine": { "type": "command", "command": "~/.claude/statusline-usage.sh" } }
   ```

4. Copy `herdr-core/templates/` to `~/.config/herdr-core/templates/`.
5. For `herdr-md` math and diagram rendering, run `npm install` in `mods/herdr-md/render`.
6. Choose the `herdr-usage` layout with `cmd-shift-l`.

`contributions` uses the pixel fonts of the app's built-in `win98` mod.

## Update this repo

`./export.sh` copies the live config from `~/.config/herdr-app` into this folder. It skips app state, built-in mods, `node_modules` and caches. Read `git diff` before you commit.
