/**
 * Pure run registry and rendering helpers for the subagent extension.
 *
 * This module imports nothing at runtime so the logic can be exercised directly:
 *
 *   node runs.ts   # runs the self-check
 */

export type RunStatus = "running" | "done" | "failed";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ToolItem {
	kind: "tool";
	/** Child-process tool call id; correlates start and end events. */
	id?: string;
	name: string;
	args: Record<string, unknown>;
	running: boolean;
}

export interface TextItem {
	kind: "text";
	text: string;
}

/** A `/skill:<name>` expansion the child agent received as its user message. */
export interface SkillItem {
	kind: "skill";
	name: string;
}

export type RunItem = ToolItem | TextItem | SkillItem;

export interface Run {
	id: string;
	agent: string;
	task: string;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	items: RunItem[];
	liveText: string;
	/** Thinking deltas of the in-flight assistant message, from the JSON stream. */
	liveThinking: string;
	/** Child session id from the JSON stream header; open with `pi --session <id>` or /resume. */
	sessionId?: string;
	/** Directory the child was given with --session-dir; its session file lives here. */
	sessionDir?: string;
	usage: UsageStats;
	model?: string;
	error?: string;
}

/** Structural subset of a pi message, enough to extract text and usage. */
export interface MessagePart {
	type: string;
	text?: string;
}

export interface MessageLike {
	role?: string;
	content?: MessagePart[] | string;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

/** Theme shim so this module stays independent of the TUI package. */
export interface Palette {
	fg: (color: string, text: string) => string;
}

/** Insertion-ordered registry of every subagent run in the session. */
export const runs = new Map<string, Run>();

export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function createRun(id: string, agent: string, task: string): Run {
	const run: Run = {
		id,
		agent,
		task,
		status: "running",
		startedAt: Date.now(),
		items: [],
		liveText: "",
		liveThinking: "",
		usage: emptyUsage(),
	};
	runs.set(id, run);
	return run;
}

export function finishRun(run: Run, status: "done" | "failed", error?: string): void {
	run.status = status;
	run.endedAt = Date.now();
	run.error = error;
	run.liveText = "";
	run.liveThinking = "";
	for (const item of run.items) {
		if (item.kind === "tool") item.running = false;
	}
}

/** Drop finished runs. Returns how many were removed. */
export function clearFinishedRuns(): number {
	let removed = 0;
	for (const [id, run] of runs) {
		if (run.status !== "running") {
			runs.delete(id);
			removed++;
		}
	}
	return removed;
}

export function textItemsFromMessage(message: MessageLike): TextItem[] {
	const parts = Array.isArray(message.content) ? message.content : [];
	const items: TextItem[] = [];
	for (const part of parts) {
		if (part.type === "text" && part.text && part.text.trim()) {
			items.push({ kind: "text", text: part.text });
		}
	}
	return items;
}

export function accumulateUsage(usage: UsageStats, message: MessageLike): void {
	if (message.role !== "assistant") return;
	usage.turns++;
	const reported = message.usage;
	if (!reported) return;
	usage.input += reported.input ?? 0;
	usage.output += reported.output ?? 0;
	usage.cacheRead += reported.cacheRead ?? 0;
	usage.cacheWrite += reported.cacheWrite ?? 0;
	usage.cost += reported.cost?.total ?? 0;
	if (reported.totalTokens) usage.contextTokens = reported.totalTokens;
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	if (minutes < 60) return `${minutes}m${rest.toString().padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function formatUsage(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolSummary(name: string, args: Record<string, unknown>): string {
	const shorten = (p: string) => {
		const home = process.env.HOME;
		return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const text = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
	const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

	switch (name) {
		case "bash":
			return `$ ${truncate(oneLine(text(args.command, "...")), 70)}`;
		case "read": {
			const file = shorten(text(args.file_path ?? args.path, "..."));
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			if (offset === undefined && limit === undefined) return `read ${file}`;
			const start = offset ?? 1;
			const end = limit !== undefined ? start + limit - 1 : "";
			return `read ${file}:${start}${end ? `-${end}` : ""}`;
		}
		case "write": {
			const file = shorten(text(args.file_path ?? args.path, "..."));
			const lines = text(args.content).split("\n").length;
			return `write ${file}${lines > 1 ? ` (${lines} lines)` : ""}`;
		}
		case "edit":
			return `edit ${shorten(text(args.file_path ?? args.path, "..."))}`;
		case "ls":
			return `ls ${shorten(text(args.path, "."))}`;
		case "find":
			return `find ${text(args.pattern, "*")} in ${shorten(text(args.path, "."))}`;
		case "grep":
			return `grep /${text(args.pattern)}/ in ${shorten(text(args.path, "."))}`;
		default: {
			const preview = truncate(oneLine(JSON.stringify(args ?? {})), 60);
			return `${name} ${preview}`;
		}
	}
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim()) ?? text;
}

/** One-line description of what a run is doing right now. */
export function activity(run: Run): string {
	const last = run.items[run.items.length - 1];
	if (last?.kind === "tool" && last.running) return formatToolSummary(last.name, last.args);
	if (run.liveText.trim()) return truncate(firstLine(run.liveText), 70);
	if (last?.kind === "tool") return formatToolSummary(last.name, last.args);
	if (last?.kind === "text") return truncate(firstLine(last.text), 70);
	return "starting…";
}

/**
 * First row of a `size`-row window that keeps `selectedId` visible, defaulting
 * to the newest rows when nothing is selected.
 */
export function windowStart(list: Run[], size: number, selectedId: string | null): number {
	const last = Math.max(0, list.length - size);
	const index = selectedId ? list.findIndex((run) => run.id === selectedId) : -1;
	if (index < 0) return last;
	return Math.min(last, Math.max(0, index - size + 1));
}

/** Widget rows below the editor. `selectedId` marks the row the picker points at. */
export function widgetLines(list: Run[], palette: Palette, max = 4, selectedId: string | null = null): string[] {
	if (list.length === 0) return [];
	const start = windowStart(list, max, selectedId);
	const shown = list.slice(start, start + max);
	const lines: string[] = [];

	if (start > 0) {
		lines.push(palette.fg("muted", `  … ${start} earlier`));
	}

	for (const run of shown) {
		const pointer = run.id === selectedId ? palette.fg("accent", "❯") : " ";
		lines.push(` ${pointer} ${runHeader(run, palette)}`);
	}

	const later = list.length - (start + shown.length);
	if (later > 0) {
		lines.push(palette.fg("muted", `  … ${later} later`));
	}

	if (selectedId) {
		lines.push(palette.fg("dim", "  ↑↓ select · → open · esc back"));
	} else {
		const running = list.filter((run) => run.status === "running").length;
		lines.push(palette.fg("dim", `  ↓ then → ${running > 0 ? `watch ${running} running` : "open session"}`));
	}
	return lines;
}

/** Status header for one run: verdict icon, agent, activity or usage, elapsed time. */
export function runHeader(run: Run, palette: Palette): string {
	const icon =
		run.status === "running"
			? palette.fg("warning", "⏳")
			: run.status === "failed"
				? palette.fg("error", "✗")
				: palette.fg("success", "✓");
	const elapsed = formatDuration((run.endedAt ?? Date.now()) - run.startedAt);
	const label = `${icon} ${palette.fg("accent", run.agent)}`;
	if (run.status === "running") {
		return `${label} ${palette.fg("muted", truncate(activity(run), 70))} ${palette.fg("dim", `· ${elapsed}`)}`;
	}
	if (run.status === "failed") {
		return `${label} ${palette.fg("error", truncate(firstLine(run.error ?? "failed"), 70))} ${palette.fg("dim", `· ${elapsed}`)}`;
	}
	return `${label} ${palette.fg("dim", `${formatUsage(run.usage, run.model) || "done"} · ${elapsed}`)}`;
}

/**
 * Self-check for the pure logic. Run with `node runs.ts`.
 */
function selfCheck(): void {
	const identity: Palette = { fg: (_color, text) => text };
	runs.clear();

	const scout = createRun("a", "scout", "find the chat router");
	const readItem: ToolItem = {
		kind: "tool",
		name: "read",
		args: { path: "/home/kris/src/router.ts", limit: 20 },
		running: true,
	};
	scout.items.push(readItem);
	if (!activity(scout).includes("read ~/src/router.ts:1-20")) throw new Error(`bad activity: ${activity(scout)}`);

	readItem.running = false;
	scout.items.push(...textItemsFromMessage({ role: "assistant", content: [{ type: "text", text: "Found it in router.ts" }] }));
	if (!activity(scout).includes("Found it")) throw new Error(`bad activity after text: ${activity(scout)}`);

	const usage = emptyUsage();
	accumulateUsage(usage, { role: "assistant", usage: { input: 1200, output: 340, cost: { total: 0.0021 }, totalTokens: 8100 } });
	accumulateUsage(usage, { role: "user", usage: { input: 999 } });
	if (usage.turns !== 1 || usage.input !== 1200 || usage.contextTokens !== 8100) throw new Error("bad usage accumulation");
	if (!formatUsage(usage).includes("$0.0021")) throw new Error(`bad usage format: ${formatUsage(usage)}`);

	scout.liveThinking = "pondering the router";
	finishRun(scout, "done");
	if (scout.items.some((item) => item.kind === "tool" && item.running)) throw new Error("finishRun left a tool running");
	if (scout.liveText.trim() || scout.liveThinking.trim()) throw new Error("live buffers should be cleared on finish");
	const worker = createRun("b", "worker", "write the test");
	const widget = widgetLines([scout, worker], identity);
	if (widget.length !== 3) throw new Error(`unexpected widget lines: ${widget.length}`);
	if (!widget[0].includes("✓ scout")) throw new Error(`missing done icon: ${widget[0]}`);
	if (!widget[1].includes("⏳ worker")) throw new Error(`missing running icon: ${widget[1]}`);
	if (!widget[2].includes("watch 1 running")) throw new Error(`missing hint: ${widget[2]}`);

	const picked = widgetLines([scout, worker], identity, 4, "b");
	if (!picked[1].includes("❯")) throw new Error(`missing picker pointer: ${picked[1]}`);
	if (picked[0].includes("❯")) throw new Error(`pointer on the wrong run: ${picked[0]}`);
	if (!picked[2].includes("↑↓ select")) throw new Error(`missing picker hint: ${picked[2]}`);

	if (clearFinishedRuns() !== 1 || runs.size !== 1) throw new Error("clearFinishedRuns should remove only the finished run");
	finishRun(worker, "failed", "No API key");
	if (!widgetLines([worker], identity)[0].includes("No API key")) throw new Error("failed reason not shown");

	// The widget window follows the picker across every run, not just the newest 4.
	const many = Array.from({ length: 10 }, (_, i) => createRun(`r${i}`, `agent${i}`, `task ${i}`));
	const scrolled = widgetLines(many, identity, 4, "r4");
	if (!scrolled[0].includes("… 1 earlier")) throw new Error(`missing earlier marker: ${scrolled[0]}`);
	if (!scrolled.some((line) => line.includes("agent4"))) throw new Error("selected run scrolled out of the window");
	if (!scrolled.some((line) => line.includes("… 5 later"))) throw new Error("missing later marker");
	const tail = widgetLines(many, identity, 4, "r9");
	if (!tail.some((line) => line.includes("agent9")) || tail.some((line) => line.includes("later"))) {
		throw new Error("newest window should show the last run and no later marker");
	}
	if (windowStart(many, 4, null) !== 6) throw new Error("unselected window should show the newest runs");

	// A skill-expanded user message renders as a label line and is not "activity".
	const skilled = createRun("c", "delegate", "/skill:implement /tmp/issue.md");
	skilled.items.push({ kind: "skill", name: "implement" });
	if (activity(skilled) !== "starting…") throw new Error(`skill item should not be activity: ${activity(skilled)}`);

	// The header carries the verdict; the child session id is carried for the picker.
	const finished = createRun("d", "worker", "fix the bug");
	finished.sessionId = "01a0f0b8-4c29-7404-b472-411d82852218";
	finishRun(finished, "done");
	if (!runHeader(finished, identity).includes("✓ worker")) throw new Error(`bad run header: ${runHeader(finished, identity)}`);

	console.log("runs.ts self-check ok");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (isDirectRun) selfCheck();
