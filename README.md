# pi extensions

Six [pi](https://github.com/earendil-works/pi) coding-agent extensions. Written for pi 1.x, TypeScript, no build step, no dependencies.

| Directory | What it adds | Config needed |
| --- | --- | --- |
| `subagent/` | `subagent` tool — spawns child pi processes with isolated context, using agent definitions from `~/.pi/agent/agents/*.md` | agent definition files |
| `ask-user/` | `ask_user` tool — one form holding every question, answered one at a time, review step before sending | none |
| `mode-switching/` | build / plan / ask modes, `shift+tab` cycles them, per-mode tool whitelists, mode prompt injected as a system section | `keybindings.json` edit (below) |
| `aurora-line/` | Visual: aurora curtains while the agent streams | none |
| `last-user-message/` | Latest submitted user message on the right of the editor's top border, fixed 40-column preview | none |
| `skill-rider/` | `/skill-rider` command — append an extra prompt to any skill without editing the skill's own files | optional rider store |

## Install

Install it as a pi package — do not copy files into `~/.pi/agent/extensions/`.

```bash
# any machine that only consumes the extensions
pi install git:github.com/FourWindff/pi-extensions

# the machine that edits this repo (live files, nothing to copy)
pi install /home/kris/Code/pi-extensions
```

Restart pi. `/reload` is not enough: the extension source changed.

Both forms end up in `~/.pi/agent/settings.json` under `packages`. The package is one unit: the root `package.json` declares all six entry points under `pi.extensions`, so a single install covers all of them.

Pick one form per machine. Never both, and never a manual copy next to it — pi would load the same extension twice and register `ask_user` / `subagent` twice.

**Do not run `npm install`.** pi's extension loader (jiti) aliases `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui` and `typebox` to its own installed copies; those are `peerDependencies` here on purpose.

### Which form to use

| Form | Where the files live | Gets update notices |
| --- | --- | --- |
| `git:github.com/FourWindff/pi-extensions` | pi-managed clone in `~/.pi/agent/git/github.com/FourWindff/pi-extensions` | yes (below) |
| local path `/home/kris/Code/pi-extensions` | your own checkout, loaded in place, never copied | **no** |

## Updating

With the git form, pi checks at every startup whether the remote HEAD moved. When it has, the chat opens with a red-bordered box:

```
Package Updates Available
Package updates are available. Run pi update --extensions
Packages:
- github.com/FourWindff/pi-extensions
```

Then:

```bash
pi update --extensions                                  # all packages
pi update git:github.com/FourWindff/pi-extensions       # just this one
```

Update does `git fetch` + `git reset --hard` on the configured ref plus a dependency reconcile, so local edits inside the pi-managed clone are discarded — that clone is not a working copy. Restart pi afterwards.

**The local-path form never notifies.** Update checks skip local packages by design (no remote to compare against). On the machine that edits this repo, `git pull` then `/reload` is the update path; that machine pushes, everyone else gets the startup notice.

Both checks are skipped when `PI_OFFLINE` is set or the source is pinned to a ref (`@v1`, `@<sha>`).

## Verify each one

Run inside pi after the restart:

1. `/tools` lists `ask_user` and `subagent`.
2. `/hotkeys` shows `Shift+Tab — Cycle agent mode (build → plan → ask)`. If it does not, see the keybinding step below.
3. `/skill-rider` opens the panel; `Esc` closes it.
4. Send any message and watch a streaming response: aurora curtains appear and dissolve when the run ends.
5. The submitted message appears on the right of the editor's top border; both borders use the same `── ` prefix, with the mode label aligned to the working status block (including its spinner).

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

### last-user-message — nothing to configure

The latest submitted user message appears on the right of the editor's first border line. The preview occupies 40 terminal columns, right-aligns short messages with border dashes filling unused space on the left and one space before the text, collapses multiline input and truncates long messages with `…`. Its trailing ` ──` mirrors the working status prefix `── `. Chinese and emoji use their terminal display width. Narrow windows shorten the preview or hide it to leave at least 40 columns for the native working/scroll status. Images appear as `[image]`; terminal control sequences are removed.

It restores from the active session branch on startup/resume/reload and tree navigation. Draft input and queued messages do not replace the preview until they enter the conversation. It adds no transcript entries and does nothing outside TUI mode. See [`last-user-message/README.md`](last-user-message/README.md) for the rendering self-check.

### ask-user, aurora-line — nothing to configure

Both require a real TUI. In `--mode json`, print, rpc and subagent child processes, `ask_user` removes itself from the active tool set at `session_start`; aurora paints nothing.

## Tests

Node >= 22.18 (TypeScript type stripping, `node --test`). No test runner installed.

```bash
cd ask-user       && node --test
cd mode-switching && node --test
cd skill-rider    && node --test riders.test.ts
```

`last-user-message/check.ts` checks preview rendering, composition with mode-switching, and alignment using Pi's own loader dependencies (see its README). `aurora-line/check.ts` also provides rendering/wiring assertions. `subagent/` has no standalone tests.

## Layout, if you plan to modify

Each extension keeps pure logic in its own file, free of pi imports and terminal access, so it can be tested with plain `node --test`:

| Extension | Pure logic | Wiring |
| --- | --- | --- |
| `ask-user` | `questionFlow.ts` | `index.ts` (tool + rendering) |
| `mode-switching` | `policy.ts` | `index.ts` (shortcuts, tool set swap, guards) |
| `skill-rider` | `riders.ts` | `index.ts`, `panel.ts` |
| `subagent` | `agents.ts` | `index.ts`, `runs.ts` |
| `aurora-line` | — | `aurora.ts`, `check.ts`, `index.ts` |
| `last-user-message` | — | `index.ts`, `check.ts` |

`ask-user`, `mode-switching` and `skill-rider` ship a README in Chinese — the authoritative source on behavior and edge cases. `subagent` and `aurora-line` are documented by comments in their own source.
