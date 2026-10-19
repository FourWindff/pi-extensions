# pi extensions

Five [pi](https://github.com/earendil-works/pi) coding-agent extensions. Written for pi 1.x, TypeScript, no build step, no dependencies.

| Directory | What it adds | Config needed |
| --- | --- | --- |
| `subagent/` | `subagent` tool — spawns child pi processes with isolated context, using agent definitions from `~/.pi/agent/agents/*.md` | agent definition files |
| `ask-user/` | `ask_user` tool — one form holding every question, answered one at a time, review step before sending | none |
| `mode-switching/` | build / plan / ask modes, `shift+tab` cycles them, per-mode tool whitelists, mode prompt injected as a system section | `keybindings.json` edit (below) |
| `aurora-line/` | Visual: aurora curtains while the agent streams | none |
| `skill-rider/` | `/skill-rider` command — append an extra prompt to any skill without editing the skill's own files | optional rider store |

## Install

```bash
git clone https://github.com/FourWindff/pi-extensions.git
mkdir -p ~/.pi/agent/extensions
cp -R pi-extensions/{ask-user,aurora-line,mode-switching,skill-rider,subagent} ~/.pi/agent/extensions/
```

Then in pi: `/reload`. Anything not picked up needs a restart.

Location is load-bearing: pi auto-loads every `.ts` file and every folder with an `index.ts` under `~/.pi/agent/extensions/`. Folders that are not extensions (mode files, tests) are fine — pi only reads `index.ts` from a folder.

**Do not run `npm install`.** pi's extension loader (jiti) aliases `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui` and `typebox` to its own installed copies. A missing `node_modules` here is expected.

## Verify each one

Run inside pi after `/reload`:

1. `/tools` lists `ask_user` and `subagent`.
2. `/hotkeys` shows `Shift+Tab — Cycle agent mode (build → plan → ask)`. If it does not, see the keybinding step below.
3. `/skill-rider` opens the panel; `Esc` closes it.
4. Send any message and watch a streaming response: aurora curtains appear and dissolve when the run ends.

## Per-extension prerequisites

### mode-switching — shift+tab must be freed first

`shift+tab` is a reserved pi binding (`app.thinking.cycle`) that extensions cannot override. Without this edit the shortcut registration is skipped silently — only a warning in the startup log, no other breakage.

`~/.pi/agent/keybindings.json`:

```json
{ "app.thinking.cycle": "alt+t" }
```

Merge into the existing object, do not overwrite the file. Then restart pi.

Mode whitelists live in `mode-switching/plan.md` and `mode-switching/ask.md`:

```markdown
---
name: plan
tools: read, grep, find, ls, bash, write, edit, subagent, ask_user   # shortened
---
(prompt body, injected as the system prompt's mode section)
```

`tools` is a **complete** list — a newly installed tool does not appear in a mode until its name is added. `name` missing = invalid file = no switch. Fragments are re-read on `/reload` only. The mode files sit inside `mode-switching/` on purpose: `~/.pi/agent/agents/` is scanned by `subagent/` and every file there becomes a dispatchable agent.

What the guards actually enforce, so you do not have to trust the prompt:

- **plan**: `write`/`edit` allowed only under `<cwd>/.pi/plans/*.md`; `bash` unrestricted (deliberate — no command-string parsing); `subagent` may only dispatch read-only agents.
- **ask**: no `write`/`edit` at all; `bash` limited to a read-only command whitelist; `subagent` limited to `explore`.

### subagent — needs agent definitions

The tool looks in two places for `*.md` files with frontmatter (`name`, `description`, optional `tools` / `model`):

- `<cwd>/.pi/agents/` and parent directories up to the repo root (project agents)
- `~/.pi/agent/agents/` (user agents)

None are shipped in this repo — write your own. Minimal example, `~/.pi/agent/agents/explore.md`:

```markdown
---
name: explore
description: Read-only codebase exploration. Use for broad searches and multi-file questions.
---
You search and read code. You do not modify files.
```

`mode-switching/plan.md` and `ask.md` whitelist the name `explore`, so name a read-only agent `explore` or edit those whitelists. With zero agent files the tool still registers but has nothing to dispatch.

The child process reuses the current pi invocation (`process.execPath` + current script), so it works from a global install, a local install, or a bundled binary, without a hardcoded path.

### skill-rider — optional store

Extra prompts per skill live in `~/.pi/agent/skill-riders.json`, created by the panel on first save:

```json
{ "version": 1, "riders": { "ponytail-audit": "extra prompt text" } }
```

Empty content deletes the entry. Skill list changes need `/reload`; rider text is re-read on every use.

### ask-user, aurora-line — nothing to configure

Both require a real TUI. In `--mode json`, print, rpc and subagent child processes, `ask_user` removes itself from the active tool set at `session_start`; aurora paints nothing.

## Tests

Node >= 22.18 (TypeScript type stripping, `node --test`). No test runner installed.

```bash
cd ask-user       && node --test
cd mode-switching && node --test
cd skill-rider    && node --test riders.test.ts
```

`subagent/` and `aurora-line/` have no tests — both are mostly wiring around pi APIs.

## Layout, if you plan to modify

Each extension keeps pure logic in its own file, free of pi imports and terminal access, so it can be tested with plain `node --test`:

| Extension | Pure logic | Wiring |
| --- | --- | --- |
| `ask-user` | `questionFlow.ts` | `index.ts` (tool + rendering) |
| `mode-switching` | `policy.ts` | `index.ts` (shortcuts, tool set swap, guards) |
| `skill-rider` | `riders.ts` | `index.ts`, `panel.ts` |
| `subagent` | `agents.ts` | `index.ts`, `runs.ts` |
| `aurora-line` | — | `aurora.ts`, `check.ts`, `index.ts` |

`ask-user`, `mode-switching` and `skill-rider` ship a README in Chinese — the authoritative source on behavior and edge cases. `subagent` and `aurora-line` are documented by comments in their own source.
