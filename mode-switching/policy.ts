/**
 * Pure policy for the three agent modes: build / plan / ask.
 *
 * No pi runtime, no filesystem, no terminal here, so the rules can be
 * exercised directly: `node --test policy.test.ts`. The only import is
 * node:path (pure stdlib) for path normalisation in the plan-file guard.
 * index.ts only translates these decisions into pi calls.
 */

import { isAbsolute, relative, resolve } from "node:path";

export type Mode = "build" | "plan" | "ask";

/** Cycle order, and the only order the user can walk it in. */
export const MODES: readonly Mode[] = ["build", "plan", "ask"];

/** Theme role per mode: build blue, plan yellow, ask green. */
export const MODE_COLORS: Record<Mode, "border" | "warning" | "success"> = {
	build: "border",
	plan: "warning",
	ask: "success",
};

/** Plan files live here, relative to the working directory. */
export const PLAN_DIR = ".pi/plans";

/** The one-step transition; `mode` is never changed by anything but the user. */
export function nextMode(mode: Mode): Mode {
	const index = MODES.indexOf(mode);
	return MODES[(index + 1) % MODES.length] as Mode;
}

export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export interface ModeFile {
	/** Frontmatter `name`; required, so a file without it never takes effect. */
	name: string;
	/** Tools enabled for this mode, in the order written. */
	tools: string[];
	/** Prompt text injected as the `mode` system prompt section. */
	body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export function parseModeFile(text: string): ModeFile | undefined {
	const match = FRONTMATTER.exec(text);
	if (!match) return undefined;

	const fields = new Map<string, string>();
	for (const line of match[1]!.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const separator = trimmed.indexOf(":");
		if (separator === -1) continue;
		fields.set(trimmed.slice(0, separator).trim().toLowerCase(), unquote(trimmed.slice(separator + 1).trim()));
	}

	const name = fields.get("name");
	if (!name) return undefined;

	const tools = fields.get("tools");
	return {
		name,
		// A missing `tools` line means no tools, never "all tools".
		tools: tools === undefined ? [] : parseToolList(tools),
		body: text.slice(match[0].length).trim(),
	};
}

/** Accepts both `tools: a, b` and `tools: [a, b]`. */
function parseToolList(raw: string): string[] {
	const inner = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
	return inner
		.split(",")
		.map((name) => unquote(name.trim()))
		.filter((name) => name.length > 0);
}

function unquote(value: string): string {
	const quoted = /^(["'])(.*)\1$/.exec(value);
	return quoted ? quoted[2]! : value;
}

export interface LoadoutInput {
	mode: Mode;
	/** Tool whitelist from the mode file; ignored for build. */
	whitelist: string[];
	/** Tool names registered in this pi process; unknown whitelist entries are dropped. */
	registered: string[];
	/** Active tools captured when build was left; restored verbatim, order included. */
	snapshot: string[];
}

export function resolveTools(input: LoadoutInput): string[] {
	if (input.mode === "build") return [...input.snapshot];
	const known = new Set(input.registered);
	return input.whitelist.filter((name) => known.has(name));
}

export interface ModeEntryData {
	mode?: unknown;
	toolsBeforeMode?: unknown;
	/** Set by this version: the snapshot came from a settled tool set. */
	toolsSettled?: unknown;
}

/**
 * A stored mode is only restorable together with a trusted tool snapshot.
 * Entries written before snapshots carried a provenance flag are refused: one
 * of them was taken seconds after launch, when the live tool set still lacked
 * tools that register later, and restoring it left build mode crippled.
 */
export function isRestorableEntry(
	data: ModeEntryData | undefined,
): data is { mode: Exclude<Mode, "build">; toolsBeforeMode: string[] } {
	if (!data) return false;
	if (!isMode(data.mode) || data.mode === "build") return false;
	if (data.toolsSettled !== true) return false;
	const list = data.toolsBeforeMode;
	return Array.isArray(list) && list.every((name): name is string => typeof name === "string");
}

export interface ToolApplyInput {
	/** Names handed to the runtime's set-active-tools call. */
	requested: string[];
	/** Names the runtime reports as active right after that call. */
	applied: string[];
	/** Every tool registered in this process. */
	registered: string[];
}

export type ToolApplyDecision = { retry: string[] } | { unresolved: string[] };

/**
 * Decide what to do when a set-active-tools call did not take effect as asked.
 *
 * The runtime applies the list as one unit, so a single name it no longer knows
 * (an MCP tool whose server went away, a tool an extension unregistered) turns
 * the whole call into a no-op — that is how build mode once came back carrying
 * the previous mode's tools. So: if something registered went missing while an
 * unregistered name was also requested, resend without the strays. Names the
 * runtime does not know are never reported: they are unavailable by design.
 */
export function resolveToolApply(input: ToolApplyInput): ToolApplyDecision {
	const registered = new Set(input.registered);
	const applied = new Set(input.applied);
	const lost = input.requested.filter((name) => registered.has(name) && !applied.has(name));
	if (lost.length === 0) return { unresolved: [] };
	if (input.requested.some((name) => !registered.has(name))) {
		return { retry: input.requested.filter((name) => registered.has(name)) };
	}
	return { unresolved: lost };
}

export interface ToolCallInput {
	toolName: string;
	input: Record<string, unknown>;
}

export type ToolDecision = { block: false } | { block: true; reason: string };

const ALLOW: ToolDecision = { block: false };

/**
 * Subagents each mode may dispatch, by agent name. `build` is unrestricted
 * (undefined). This is the only place the choice can be made: the child is a
 * plain `pi` process with no mode state, so a write-capable agent such as
 * `general` stays reachable from a read-only mode unless it is named here.
 * A whitelist, not a blacklist: an agent added later is blocked until listed.
 */
export const ALLOWED_SUBAGENTS: Record<Mode, readonly string[] | undefined> = {
	build: undefined,
	plan: ["explore"],
	ask: ["explore"],
};

/** Agent names a `subagent` call would dispatch: single `agent` or `tasks[].agent`. */
export function requestedSubagents(input: Record<string, unknown>): string[] {
	const names: string[] = [];
	if (typeof input.agent === "string" && input.agent) names.push(input.agent);
	if (Array.isArray(input.tasks)) {
		for (const task of input.tasks) {
			const agent = (task as { agent?: unknown } | null | undefined)?.agent;
			if (typeof agent === "string" && agent) names.push(agent);
		}
	}
	return names;
}

/** Decide a tool call for one mode. Everything external is expressed here. */
export function guardToolCall(mode: Mode, cwd: string, call: ToolCallInput): ToolDecision {
	if (mode === "build") return ALLOW;

	if (call.toolName === "subagent") {
		const allowed = ALLOWED_SUBAGENTS[mode];
		if (!allowed) return ALLOW;

		const requested = requestedSubagents(call.input);
		const blocked = [...new Set(requested.filter((name) => !allowed.includes(name)))];
		if (requested.length > 0 && blocked.length === 0) return ALLOW;

		return {
			block: true,
			reason:
				`${mode} mode only dispatches the read-only ${allowed.join("/")} subagent.\n` +
				(blocked.length > 0 ? `Blocked agent: ${blocked.join(", ")}\n` : "No agent named in this call.\n") +
				`Delegating to a write-capable agent needs build mode: shift+tab cycles build → plan → ask → build.`,
		};
	}

	if (call.toolName === "bash") {
		// plan runs any command, no judgement at all — a research mode that can
		// read a file but not run the tests or a git query past a fixed list gets
		// blocked on the first real question. ask keeps the read-only allowlist.
		if (mode === "plan") return ALLOW;

		const command = typeof call.input.command === "string" ? call.input.command : "";
		if (isSafeBashCommand(command)) return ALLOW;
		return {
			block: true,
			reason:
				`${mode} mode blocks write-capable bash: redirects, deletes, installs, commits, pushes.\n` +
				`Blocked command: ${command}\n` +
				`Run it from build mode: shift+tab cycles build → plan → ask → build.`,
		};
	}

	// ask has no write tools at all; this also catches a call already in flight
	// when the user switches mode mid-turn.
	if (call.toolName === "write" || call.toolName === "edit") {
		const path = typeof call.input.path === "string" ? call.input.path : "";
		if (mode === "plan" && isPlanFilePath(cwd, path)) return ALLOW;
		return {
			block: true,
			reason:
				mode === "plan"
					? `plan mode only writes ${PLAN_DIR}/*.md.\nBlocked path: ${path}\nTo change source files, switch to build mode: shift+tab cycles build → plan → ask → build.`
					: `ask mode does not modify files.\nBlocked ${call.toolName}: ${path}\nSwitch to build mode with shift+tab to make changes.`,
		};
	}

	return ALLOW;
}

/** True when `target` (relative or absolute) resolves inside `<cwd>/.pi/plans/` and is markdown. */
export function isPlanFilePath(cwd: string, target: string): boolean {
	if (!target.toLowerCase().endsWith(".md")) return false;
	const plansDir = resolve(cwd, PLAN_DIR);
	const relativePath = relative(plansDir, resolve(cwd, target));
	return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

// Write detection for ask mode: a command is allowed only if it matches no
// destructive pattern *and* starts with a known read-only shape below.
// Reused from pi's plan-mode example (examples/extensions/plan-mode/utils.ts),
// plus three write-capable flags that the upstream list lets through
// (curl -o/-O, find -delete/-exec, sort -o).
// ponytail: heuristic, not a sandbox. Per-command parsing if ask ever needs to
// hold against a hostile model.
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
	/\bcurl\b[^\n]*\s-(o|O)\b/,
	/\bfind\b[^\n]*\s-(delete|exec|execdir|ok|okdir|fprint|fls)\b/,
	/\bsort\b[^\n]*\s-o\b/,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

function hasDestructiveCommand(command: string): boolean {
	return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command));
}

export function isSafeBashCommand(command: string): boolean {
	return !hasDestructiveCommand(command) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}
