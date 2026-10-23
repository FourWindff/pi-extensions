/**
 * Mode switching extension: build / plan / ask.
 *
 * shift+tab cycles the three modes (it needs keybindings.json to move
 * app.thinking.cycle off shift+tab first — see README.md). Entering a mode
 * swaps the active tool set to the whitelist in its mode file and injects the
 * mode prompt as a system prompt section; build restores the exact tool set
 * captured when it was left, order included.
 *
 * The mode only ever changes when the user asks for the next one: no tool, no
 * turn event, no timer flips it. New sessions start in build, resuming a
 * session restores the mode stored in its entries.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CustomEditor,
	FooterComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type EditorComponent,
	type EditorTheme,
	Key,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	guardToolCall,
	isMode,
	isRestorableEntry,
	MODE_COLORS,
	MODES,
	nextMode,
	parseModeFile,
	resolveToolApply,
	resolveTools,
	type Mode,
	type ModeEntryData,
	type ModeFile,
} from "./policy.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

/** Custom session entry holding the current mode. */
const MODE_ENTRY = "mode-switching";
/** System prompt section tag carrying the mode prompt. */
const MODE_SECTION = "mode";
const MODE_FILES: Record<StatefulMode, string> = { plan: "plan.md", ask: "ask.md" };
const CYCLE_HINT = `shift+tab cycles ${MODES.join(" → ")} → ${MODES[0]}`;

type StatefulMode = Exclude<Mode, "build">;
type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

export default function modeSwitching(pi: ExtensionAPI): void {
	let mode: Mode = "build";
	let toolsBeforeMode: string[] | undefined;
	/**
	 * Tool set to restore when build is re-entered. Refreshed at every turn
	 * taken in build: the live set read seconds after launch can still be
	 * missing tools that register later, and snapshotting that is how a session
	 * ended up with a permanently crippled build mode.
	 */
	let buildSnapshot: string[] | undefined;
	let editorFactory: EditorFactory | undefined;
	let editorTimer: ReturnType<typeof setTimeout> | undefined;
	/** Reads the git branch off the footer's data provider; undefined until the footer is installed. */
	let footerBranch: (() => string | null) | undefined;
	const modeFiles = new Map<StatefulMode, ModeFile | undefined>();

	function loadModeFile(name: StatefulMode): ModeFile | undefined {
		if (!modeFiles.has(name)) {
			let parsed: ModeFile | undefined;
			try {
				parsed = parseModeFile(readFileSync(join(EXTENSION_DIR, MODE_FILES[name]), "utf8"));
			} catch {
				parsed = undefined;
			}
			modeFiles.set(name, parsed);
		}
		return modeFiles.get(name);
	}

	/**
	 * Apply a tool set and verify it took effect. Returns the names still
	 * missing afterwards, so a silent no-op is reported instead of leaving the
	 * mode label and the live tool set out of sync.
	 */
	function setToolsFor(target: Mode, file: ModeFile | undefined, snapshot: string[] | undefined): string[] {
		const registered = pi.getAllTools().map((tool) => tool.name);
		const requested = resolveTools({
			mode: target,
			whitelist: file?.tools ?? [],
			registered,
			snapshot: snapshot ?? pi.getActiveTools(),
		});

		try {
			pi.setActiveTools(requested);
			let decision = resolveToolApply({ requested, applied: pi.getActiveTools(), registered });
			if ("retry" in decision) {
				pi.setActiveTools(decision.retry);
				decision = resolveToolApply({ requested: decision.retry, applied: pi.getActiveTools(), registered });
			}
			return "unresolved" in decision ? decision.unresolved : [];
		} catch {
			// A throwing apply must not pass for a successful one.
			return requested;
		}
	}

	function cycleMode(ctx: ExtensionContext): void {
		const next = nextMode(mode);
		let file: ModeFile | undefined;
		if (next !== "build") {
			file = loadModeFile(next);
			if (!file) {
				ctx.ui.notify(
					`Cannot switch to ${next}: ${MODE_FILES[next]} is missing, unreadable, or has no "name" frontmatter. Staying in ${mode}.`,
					"error",
				);
				return;
			}
		}

		const snapshot = mode === "build" ? (buildSnapshot ?? pi.getAllTools().map((tool) => tool.name)) : toolsBeforeMode;
		mode = next;
		toolsBeforeMode = next === "build" ? undefined : snapshot;
		const lost = setToolsFor(next, file, snapshot);
		pi.appendEntry(MODE_ENTRY, { mode, toolsBeforeMode, toolsSettled: next !== "build" });
		if (lost.length === 0) {
			ctx.ui.notify(`${next} mode · ${CYCLE_HINT}`, "info");
		} else {
			ctx.ui.notify(
				`${next} mode, but these tools did not activate: ${lost.join(", ")}. ${CYCLE_HINT}`,
				"warning",
			);
		}
	}

	function readStoredMode(ctx: ExtensionContext): { mode: StatefulMode; toolsBeforeMode: string[] } | undefined {
		const entries = ctx.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index] as { type?: string; customType?: string; data?: ModeEntryData };
			if (entry.type !== "custom" || entry.customType !== MODE_ENTRY) continue;
			// A non-build mode is only useful together with the tool set it was left
			// from; without one, restoring would strand the user in a restricted set
			// that build cannot restore from.
			return isRestorableEntry(entry.data) ? { mode: entry.data.mode, toolsBeforeMode: entry.data.toolsBeforeMode } : undefined;
		}
		return undefined;
	}

	pi.on("session_start", (_event, ctx) => {
		mode = "build";
		toolsBeforeMode = undefined;
		buildSnapshot = undefined;
		footerBranch = undefined;

		// No switching entry point outside the TUI, so the feature stays off
		// entirely there instead of restoring a mode nobody can leave.
		if (ctx.mode !== "tui") return;

		const stored = readStoredMode(ctx);
		if (stored) {
			const file = loadModeFile(stored.mode);
			if (file) {
				mode = stored.mode;
				toolsBeforeMode = stored.toolsBeforeMode;
				const lost = setToolsFor(mode, file, toolsBeforeMode);
				if (lost.length > 0) {
					const detail = `Restored ${stored.mode} mode is missing tools: ${lost.join(", ")}.`;
					ctx.ui.notify(`${detail} Run /tools to check.`, "warning");
				}
			} else {
				ctx.ui.notify(
					`Restored session was in ${stored.mode} mode, but ${MODE_FILES[stored.mode]} is missing or invalid. Started in build mode.`,
					"error",
				);
			}
		}
		// No switching entry point outside the TUI, so the feature stays off
		// entirely there instead of restoring a mode nobody can leave.
		if (ctx.mode !== "tui") return;

		installFooter(ctx);
		installEditor(ctx);
		// Other extensions take the editor slot in their own session_start handler,
		// which may run after ours, so claim it again once startup has settled.
		editorTimer = setTimeout(() => installEditor(ctx), 0);
	});

	pi.on("before_agent_start", (event) => {
		if (mode === "build") {
			// Settled by now: this is the set the next switch back to build restores.
			buildSnapshot = pi.getActiveTools();
			delete event.systemPromptOptions.sections[MODE_SECTION];
			return;
		}
		const body = loadModeFile(mode)?.body;
		if (body) event.systemPromptOptions.sections[MODE_SECTION] = body;
		else delete event.systemPromptOptions.sections[MODE_SECTION];
	});

	pi.on("tool_call", (event, ctx) => {
		if (mode === "build") return;
		const decision = guardToolCall(mode, ctx.cwd, {
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
		});
		if (decision.block) return { block: true, reason: decision.reason };
	});

	// setEditorComponent is a single slot and other extensions take it too, so
	// re-wrap whenever someone replaced us instead of trusting load order.
	pi.on("turn_start", (_event, ctx) => installEditor(ctx));

	pi.on("session_shutdown", () => {
		clearTimeout(editorTimer);
		editorTimer = undefined;
	});

	pi.registerShortcut(Key.shift("tab"), {
		description: "Cycle agent mode (build → plan → ask)",
		handler: (ctx) => cycleMode(ctx),
	});

	function installEditor(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		if (editorFactory && ctx.ui.getEditorComponent() === editorFactory) return;

		const inner = ctx.ui.getEditorComponent();
		editorFactory = (tui, theme, keybindings) => {
			const component = inner
				? inner(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			return decorateBottomBorder(component, theme, (width) => borderLabel(ctx, mode, footerBranch?.(), width));
		};
		ctx.ui.setEditorComponent(editorFactory);
	}

	/**
	 * Replace pi's footer with its own stats line minus the pwd line: that
	 * information now sits on the editor border, next to the mode.
	 */
	function installFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			footerBranch = () => footerData.getGitBranch();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			const footer = new FooterComponent(footerSession(ctx, pi.getThinkingLevel()) as never, footerData);
			return {
				invalidate: () => footer.invalidate(),
				dispose: () => {
					unsubscribe();
					footer.dispose();
				},
				render: (width: number) => {
					// ponytail: assumes pi's footer keeps pwd as its first line; fix the
					// slice here (or write a custom footer) if a pi update reorders it.
					try {
						return footer.render(width).slice(1);
					} catch {
						// A stale shim must not take the whole TUI down with it.
						return [truncateToWidth(theme.fg("error", "footer unavailable"), width)];
					}
				},
			};
		});
	}
}

/**
 * Stand-in for the AgentSession pi's exported footer component expects: ctx
 * carries the same reads (session manager, model, thinking level, context
 * usage). `routedModel` has no extension-visible equivalent, so the footer
 * drops its virtual-model arrow.
 */
function footerSession(ctx: ExtensionContext, thinkingLevel: string) {
	return {
		sessionManager: ctx.sessionManager as typeof ctx.sessionManager & { getEntryCount(): number },
		model: ctx.model,
		state: { model: ctx.model, thinkingLevel },
		getContextUsage: () => ctx.getContextUsage(),
		modelRuntime: {
			isUsingSubscription: (provider: string) =>
				ctx.model !== undefined &&
				ctx.modelRegistry.isUsingOAuth(ctx.model) &&
				ctx.modelRegistry.getProvider(provider)?.auth.oauth?.isSubscription === true,
		},
	};
}

/** ` build  ~/Code/MindLane (main) ` — the location shrinks, then goes, before the mode when the width is tight. */
function borderLabel(ctx: ExtensionContext, mode: Mode, branch: string | null | undefined, width: number): string {
	const theme = ctx.ui.theme;
	const modeText = theme.fg(MODE_COLORS[mode], ` ${mode} `);
	const location = `${formatCwd(ctx.cwd)}${branch ? ` (${branch})` : ""}`;
	const room = width - visibleWidth(modeText) - 3;
	if (room <= 8) return modeText;
	return modeText + theme.fg("dim", ` ${truncateToWidth(location, room - 2, "…")} `);
}

/** Home-relative path, the shape the footer used to print. */
function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

/**
 * Wrap an editor component so its bottom border shows the mode and location.
 *
 * Everything else is forwarded untouched (handleInput included), which keeps
 * whatever the previous editor added working — e.g. the subagent run picker.
 */
function decorateBottomBorder(
	component: EditorComponent,
	theme: EditorTheme,
	label: (width: number) => string,
): EditorComponent {
	const editor = component as EditorComponent & {
		renderBottomBorder?: (width: number, hiddenLines: number) => string;
		borderColor?: (text: string) => string;
	};
	if (editor.renderBottomBorder) {
		editor.renderBottomBorder = (width: number) =>
			bottomBorderWithLabel(width, label, editor.borderColor ?? theme.borderColor);
	}

	return new Proxy(component, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) {
			return Reflect.set(target, property, value, target);
		},
	});
}

/** `── build ~/Code/MindLane (main) ──` — same prefix as the native working status border. */
function bottomBorderWithLabel(
	width: number,
	label: (maxWidth: number) => string,
	borderColor: (text: string) => string,
): string {
	const text = label(width);
	const labelWidth = visibleWidth(text);
	if (width < labelWidth + 3) return borderColor("─".repeat(Math.max(0, width)));
	return borderColor("──") + text + borderColor("─".repeat(width - labelWidth - 2));
}
