/**
 * Subagent extension.
 *
 * Delegates tasks to specialized agents, each running in a separate `pi`
 * process with an isolated context window. Each run keeps its own pi session
 * (`--name subagent <agent>: <task>`), so the conversation stays out of the main
 * transcript; the main transcript keeps only the tool call and its final result.
 * The widget below the editor lists runs; pressing down on the prompt's last
 * line highlights one, and right arrow (or enter) opens it in a full-screen
 * read-only viewer tailed from the run's session file, so the main
 * conversation is never replaced.
 *
 * Modes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CONFIG_DIR_NAME,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	SessionManager,
	type Theme,
	type ThemeColor,
	ToolExecutionComponent,
	type ToolDefinition,
	UserMessageComponent,
	createCodingTools,
	createPowerShellTool,
	createReadOnlyTools,
	getAgentDir,
	getMarkdownTheme,
	parseSessionEntries,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	Container,
	compositeTuiLine,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	type Palette,
	type Run,
	type ToolItem,
	type UsageStats,
	accumulateUsage,
	clearFinishedRuns,
	createRun,
	finishRun,
	runs,
	textItemsFromMessage,
	widgetLines,
} from "./runs.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const MAX_WIDGET_RUNS = 4;
const TAB_WINDOW = 7;
const RUNS_WIDGET_KEY = "subagent-runs";

/**
 * Remembered run selection. It survives closing the picker and switching to a
 * subagent session, so the highlight comes back on the same run.
 */
let pickerRunId: string | null = null;

/**
 * True while the picker owns the arrow keys: the run highlight is shown and the
 * editor cursor is hidden. Exactly one of the two is visible at any time.
 */
let pickerActive = false;

/** Runs the picker can reach; the widget scrolls to the highlight. */
function pickerRuns(): Run[] {
	return [...runs.values()];
}

/** The remembered run, falling back to the newest one when it is gone. */
function pickerSelection(): Run | undefined {
	const shown = pickerRuns();
	return shown.find((run) => run.id === pickerRunId) ?? shown[shown.length - 1];
}

/** Show the run highlight and hand the arrows to the picker. */
function openPicker(): void {
	pickerRunId = pickerSelection()?.id ?? null;
	pickerActive = pickerRunId !== null;
}

/** Hide the run highlight and hand the arrows back to the editor. */
function closePicker(): void {
	pickerActive = false;
}

/** Move the highlight by `delta`, clamped to the list. */
function movePicker(delta: number): void {
	const shown = pickerRuns();
	if (shown.length === 0) {
		closePicker();
		pickerRunId = null;
		return;
	}
	const current = shown.findIndex((run) => run.id === pickerRunId);
	const next = current < 0 ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, current + delta));
	pickerRunId = shown[next].id;
}



/** Resolve a child session file by id inside the session directory. */
async function findSessionFile(sessionDir: string, sessionId: string): Promise<string | undefined> {
	const sessions = await SessionManager.listAll(sessionDir);
	return sessions.find((session) => session.id === sessionId)?.path;
}

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface SingleResult {
	agent: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: "single" | "parallel";
	results: SingleResult[];
}

interface RunAgentOptions {
	run: Run;
	agent: AgentConfig;
	task: string;
	cwd: string;
	/** Directory for the child's own session; nested so `/resume` does not list it. */
	sessionDir: string;
	defaults: DispatchDefaults;
	signal?: AbortSignal;
	onEvent?: () => void;
}

/** Child sessions live in a nested directory so `/resume` does not list them. */
function subagentSessionDir(sessionDir: string): string {
	return path.join(sessionDir, "subagents");
}

function preview(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function paletteOf(theme: Theme): Palette {
	return { fg: (color, text) => theme.fg(color as ThemeColor, text) };
}

/** Wrap lines in a rounded border, clipping and padding every row to fit `width`. */
function framedLines(lines: string[], width: number, theme: Theme, title?: string): string[] {
	if (lines.length === 0) return [];
	const inner = Math.max(1, width - 2);
	const edge = (text: string) => theme.fg("borderMuted", text);
	const head = title ? `─ ${title} ` : "─";
	const top = head + "─".repeat(Math.max(0, inner - visibleWidth(head)));
	return [
		edge(`╭${truncateToWidth(top, inner, "─", true)}╮`),
		...lines.map((line) => edge("│") + truncateToWidth(line, inner, "…", true) + edge("│")),
		edge(`╰${"─".repeat(inner)}╯`),
	];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr.trim() || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output is in the tool result details.]`;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, `prompt-${agentName.replace(/[^\w.-]+/g, "_")}.md`);
	await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function failedResult(run: Run, agent: string, task: string, message: string): SingleResult {
	finishRun(run, "failed", message);
	return { agent, task, exitCode: 1, messages: [], stderr: "", usage: run.usage, errorMessage: message };
}

/** Match a tool event to its item by call id, falling back to the newest running call of that name. */
function findToolItem(run: Run, wire: Record<string, any>): ToolItem | undefined {
	const id = typeof wire.toolCallId === "string" ? wire.toolCallId : undefined;
	const name = typeof wire.toolName === "string" ? wire.toolName : "";
	for (let i = run.items.length - 1; i >= 0; i--) {
		const item = run.items[i];
		if (item.kind !== "tool") continue;
		if (id !== undefined && item.id !== undefined) {
			if (item.id === id) return item;
			continue;
		}
		if (item.running && item.name === name) return item;
	}
	return undefined;
}

/**
 * Run one agent in a child `pi` process, streaming its events into `run` so the
 * widget and viewer stay live.
 */
async function runAgent(options: RunAgentOptions): Promise<SingleResult> {
	const { run, agent, task, defaults } = options;
	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: run.usage,
		model: agent.model ?? defaults.model,
	};
	run.model = result.model;
	run.sessionDir = options.sessionDir;

	// Each run keeps its own pi session so the conversation can be reopened later.
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--name",
		`subagent ${agent.name}: ${preview(task, 60)}`,
		"--session-dir",
		options.sessionDir,
	];
	if (result.model) args.push("--model", result.model);
	// An agent's own thinking level wins; otherwise inherit the parent's, unless
	// the agent pinned its own model (then the parent's level may not apply).
	const thinking = agent.thinking ?? (agent.model ? undefined : defaults.thinkingLevel);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	const handleEvent = (event: unknown): void => {
		if (!event || typeof event !== "object") return;
		const wire = event as Record<string, any>;
		switch (wire.type) {
			case "session": {
				// First record of the child stream: the session it persists to.
				if (typeof wire.id === "string") run.sessionId = wire.id;
				break;
			}
			case "message_update": {
				const delta = wire.assistantMessageEvent;
				if (typeof delta?.delta !== "string") break;
				if (delta.type === "text_delta") run.liveText += delta.delta;
				else if (delta.type === "thinking_delta") run.liveThinking += delta.delta;
				else break;
				options.onEvent?.();
				break;
			}
			case "message_end": {
				const message = wire.message as Message | undefined;
				if (!message) break;
				result.messages.push(message);
				if (message.role === "assistant") {
					accumulateUsage(result.usage, message);
					if (!result.model && message.model) result.model = message.model;
					run.model = result.model;
					if (message.stopReason) result.stopReason = message.stopReason;
					if (message.errorMessage) result.errorMessage = message.errorMessage;
					run.items.push(...textItemsFromMessage(message));
				} else if (message.role === "user") {
					// The child expands /skill:<name> into a <skill> block in the user message;
					// surface it so the inline transcript shows what the subagent was told to follow.
					const text = textItemsFromMessage(message)
						.map((item) => item.text)
						.join("\n");
					const skill = parseSkillBlock(text);
					if (skill) run.items.push({ kind: "skill", name: skill.name });
				}
				run.liveText = "";
				run.liveThinking = "";
				options.onEvent?.();
				break;
			}
			case "tool_execution_start": {
				run.items.push({
					kind: "tool",
					id: typeof wire.toolCallId === "string" ? wire.toolCallId : undefined,
					name: String(wire.toolName),
					args: wire.args ?? {},
					running: true,
				});
				options.onEvent?.();
				break;
			}
			case "tool_execution_end": {
				const item = findToolItem(run, wire);
				if (item) item.running = false;
				options.onEvent?.();
				break;
			}
			default:
				break;
		}
	};

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let wasAborted = false;

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}
		// A task starting with "/" is passed through verbatim so the child expands
		// it like typed input: /skill:<name>, prompt templates, extension commands.
		// Everything else is prefixed so the child knows it is a delegated task.
		const trimmedTask = task.trimStart();
		args.push(trimmedTask.startsWith("/") ? trimmedTask : `Task: ${task}`);

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let settled = false;
			let killTimer: NodeJS.Timeout | undefined;

			const settle = (code: number): void => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				options.signal?.removeEventListener("abort", killProc);
				resolve(code);
			};

			const processLine = (line: string): void => {
				if (!line.trim()) return;
				try {
					handleEvent(JSON.parse(line));
				} catch {
					// Subagent stdout can contain non-JSON noise; ignore it.
				}
			};

			proc.stdout.on("data", (chunk) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (chunk) => {
				result.stderr += chunk.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				buffer = "";
				settle(code ?? 0);
			});

			proc.on("error", (error) => {
				result.errorMessage = error.message;
				settle(1);
			});

			const killProc = (): void => {
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			if (options.signal?.aborted) killProc();
			else options.signal?.addEventListener("abort", killProc, { once: true });
		});

		result.exitCode = exitCode;
		if (wasAborted) {
			finishRun(run, "failed", "aborted");
		} else if (isFailedResult(result)) {
			finishRun(run, "failed", preview(getResultOutput(result), 300));
		} else {
			finishRun(run, "done");
		}
		return result;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				// ignore
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				// ignore
			}
		}
		options.onEvent?.();
	}
}

/**
 * Remove the editor cursor from a rendered line: the zero-width hardware marker
 * and the inverse-video block drawn on the cursor character.
 */
function stripEditorCursor(line: string): string {
	return line.replace(CURSOR_MARKER, "").replace(/\x1b\[7m([\s\S]*?)\x1b\[0m/g, "$1");
}

/**
 * Prompt editor that reaches into the run widget below it. Down on the prompt's
 * last visual line opens the run picker: the highlight replaces the cursor,
 * arrows move it, right arrow or enter opens that run in the full-screen
 * viewer, and up from the first run (or any other key) hands control back to
 * the prompt.
 */
class RunPickerEditor extends CustomEditor {
	private readonly refresh: () => void;
	private readonly open: () => void;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		handlers: {
			refresh: () => void;
			open: () => void;
		},
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.refresh = handlers.refresh;
		this.open = handlers.open;
	}

	render(width: number): string[] {
		// The run highlight stands in for the cursor, so strip the cursor marker and
		// its inverse-video block while the picker owns the arrows.
		const lines = super.render(width);
		return pickerActive ? lines.map(stripEditorCursor) : lines;
	}

	handleInput(data: string): void {
		// While autocomplete (slash commands, file paths) is open it owns the
		// arrows and enter; the run picker must not intercept them.
		if (this.isShowingAutocomplete()) {
			closePicker();
			this.refresh();
			super.handleInput(data);
			return;
		}

		if (!pickerActive) {
			// Down on the editor's last visual line opens the picker; every other
			// arrow (including moving between wrapped lines) belongs to the editor.
			if (runs.size > 0 && this.isOnVisualLastLine() && matchesKey(data, Key.down)) {
				openPicker();
				this.refresh();
				return;
			}
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, Key.up)) {
			// Up from the first run gives the screen back to the editor cursor.
			if (pickerRunId === pickerRuns()[0]?.id) closePicker();
			else movePicker(-1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.down)) {
			movePicker(1);
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return) || matchesKey(data, Key.right)) {
			this.open();
			return;
		}

		// Escape and anything typed leave the picker; escape must not abort the agent.
		const wasEscape = matchesKey(data, Key.escape);
		closePicker();
		this.refresh();
		if (!wasEscape) super.handleInput(data);
	}

	/**
	 * True while the cursor sits on the editor's last visual line, so wrapped text
	 * scrolls before the picker opens. The editor's helper is private in its type
	 * declarations but present at runtime.
	 */
	private isOnVisualLastLine(): boolean {
		return (this as unknown as { isOnLastVisualLine(): boolean }).isOnLastVisualLine();
	}
}

/** Text of a user message, which may be a plain string or content blocks. */
function userMessageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown };
			return block.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * Last ↑↓ scroll position per subagent session file, so closing the viewer and
 * reopening the same run resumes where it was left.
 */
const viewerPositions = new Map<string, { offset: number; follow: boolean }>();

/**
 * Partial assistant message assembled from the child's JSON deltas. The session
 * file only gets the message on `message_end`, so this keeps the viewer live.
 */
function liveAssistantMessage(run: Run): AssistantMessage | undefined {
	if (!run.liveText && !run.liveThinking) return undefined;
	const [provider = "", model = ""] = (run.model ?? "").split("/");
	return {
		role: "assistant",
		content: [
			...(run.liveThinking ? [{ type: "thinking" as const, thinking: run.liveThinking }] : []),
			...(run.liveText ? [{ type: "text" as const, text: run.liveText }] : []),
		],
		api: "live",
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: run.startedAt,
	};
}

interface LiveSessionViewerOptions {
	tui: TUI;
	theme: Theme;
	run: Run;
	sessionFile: string;
	cwd: string;
	outputPad: number;
	hideThinkingBlock: boolean;
	onClose: () => void;
}

/**
 * Full-screen live view of a running subagent session.
 *
 * Switching sessions would abort the parent turn and kill the child process, so
 * a running run is tailed from its session file and rendered with pi's own
 * message and tool components instead. The session file only receives a message
 * on `message_end`, so the in-flight message is appended from the child's JSON
 * deltas (`run.liveText` / `run.liveThinking`) to keep the view truly live.
 */
class LiveSessionViewer implements Component {
	private readonly body = new Container();
	private readonly options: LiveSessionViewerOptions;
	private readonly toolDefinitions: Map<string, ToolDefinition>;
	private poll: NodeJS.Timeout | undefined;
	private lastSize = -1;
	private lastLive = "";
	private offset = 0;
	private lineCount = 0;
	private follow = true;

	constructor(options: LiveSessionViewerOptions) {
		this.options = options;
		const saved = viewerPositions.get(options.sessionFile);
		if (saved) {
			this.offset = saved.offset;
			this.follow = saved.follow;
		}
		const definitions = [
			...createCodingTools(options.cwd),
			...createReadOnlyTools(options.cwd),
			createPowerShellTool(options.cwd),
		];
		this.toolDefinitions = new Map(definitions.map((tool) => [tool.name, tool]));
		this.refresh();
		this.poll = setInterval(() => this.refresh(), 400);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "q") {
			this.options.onClose();
			return;
		}
		const page = this.bodyHeight();
		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(page);
		else if (matchesKey(data, Key.home)) {
			this.follow = false;
			this.offset = 0;
		} else if (matchesKey(data, Key.end)) {
			this.follow = true;
		}
		this.options.tui.requestRender();
	}

	/** Mouse wheel scrolls the viewer; the overlay covers the screen, so it gets every wheel event. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scrollBy(event.wheelDelta);
		this.options.tui.requestRender();
		return { handled: true };
	}

	invalidate(): void {
		// Renders fresh state on every call.
	}

	dispose(): void {
		viewerPositions.set(this.options.sessionFile, { offset: this.offset, follow: this.follow });
		if (this.poll) clearTimeout(this.poll);
		this.poll = undefined;
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const body = this.body.render(width);
		this.lineCount = body.length;
		const height = this.bodyHeight();
		const maxOffset = Math.max(0, body.length - height);
		const offset = this.follow ? maxOffset : Math.min(this.offset, maxOffset);
		this.offset = offset;
		const position = this.follow ? "following" : `${offset + 1}-${Math.min(offset + height, body.length)}/${body.length}`;
		const label = ` subagent ${this.options.run.agent} ${this.options.run.status === "running" ? "live" : "done"} `;
		const labelWidth = visibleWidth(label);
		const left = Math.max(0, Math.floor((width - labelWidth) / 2));
		const header =
			theme.fg("border", "─".repeat(left)) +
			theme.fg("accent", theme.bold(label)) +
			theme.fg("border", "─".repeat(Math.max(0, width - left - labelWidth)));
		const hint = theme.fg("dim", ` ${position} · ↑↓ scroll · home/end · esc close`);
		const visible = body.slice(offset, offset + height);
		if (visible.length === 0) visible.push(theme.fg("muted", "  waiting for output…"));
		// Pad to the full viewport so the overlay never floats above the footer.
		while (visible.length < height) visible.push("");
		const lines = [header, hint, ...visible];
		if (!this.follow) this.compositeJumpToEnd(lines, width);
		return lines;
	}

	/**
	 * Centered "jump to latest" pill on the row above the bottom edge, mirroring
	 * the main TUI's follow-end indicator (and leaving one row of breathing room).
	 */
	private compositeJumpToEnd(lines: string[], width: number): void {
		const row = lines.length - 2;
		if (row < 0) return;
		const label = " ↓ Jump to latest message · End ";
		const labelWidth = visibleWidth(label);
		const styled = this.options.theme.bg("selectedBg", this.options.theme.fg("text", label));
		const left = Math.max(0, Math.floor((width - labelWidth) / 2));
		lines[row] = compositeTuiLine(lines[row] ?? "", styled, left, labelWidth, width);
	}

	private bodyHeight(): number {
		// Header, hint, and body fill every terminal row, so the overlay covers the
		// footer (pwd, stats, extension statuses) instead of leaving a line visible.
		return Math.max(3, (this.options.tui.terminal.rows ?? 30) - 2);
	}

	private scrollBy(delta: number): void {
		const maxOffset = Math.max(0, this.lineCount - this.bodyHeight());
		const next = Math.max(0, Math.min(maxOffset, this.offset + delta));
		this.offset = next;
		this.follow = next >= maxOffset;
	}

	/** Re-read the session file when it grew or the child streamed more deltas. */
	private refresh(): void {
		let text: string;
		try {
			text = fs.readFileSync(this.options.sessionFile, "utf-8");
		} catch {
			return;
		}
		const live = `${this.options.run.liveText}\u0000${this.options.run.liveThinking}`;
		if (text.length === this.lastSize && live === this.lastLive) return;
		this.lastSize = text.length;
		this.lastLive = live;
		this.rebuild(text);
		this.options.tui.requestRender();
	}

	private rebuild(text: string): void {
		const markdown = getMarkdownTheme();
		const tools = new Map<string, ToolExecutionComponent>();
		const children: Component[] = [];
		for (const entry of parseSessionEntries(text)) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role === "user") {
				const content = userMessageText(message);
				if (content.trim()) children.push(new UserMessageComponent(content, markdown, this.options.outputPad));
				continue;
			}
			if (message.role === "assistant") {
				children.push(
					new AssistantMessageComponent(
						message,
						this.options.hideThinkingBlock,
						markdown,
						undefined,
						this.options.outputPad,
					),
				);
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const component = new ToolExecutionComponent(
						block.name,
						block.id,
						block.arguments,
						{},
						this.toolDefinitions.get(block.name),
						this.options.tui,
						this.options.cwd,
					);
					component.markExecutionStarted();
					component.setArgsComplete();
					tools.set(block.id, component);
					children.push(component);
				}
				continue;
			}
			if (message.role === "toolResult") {
				tools
					.get(message.toolCallId)
					?.updateResult({ content: message.content, details: message.details, isError: message.isError }, false);
			}
		}
		const live = liveAssistantMessage(this.options.run);
		if (live) {
			children.push(
				new AssistantMessageComponent(live, this.options.hideThinkingBlock, markdown, undefined, this.options.outputPad),
			);
		}
		this.body.clear();
		for (const child of children) this.body.addChild(child);
	}
}

export default function subagentExtension(pi: ExtensionAPI): void {
	let widgetTui: TUI | null = null;
	let widgetActive = false;

	function touch(): void {
		widgetTui?.requestRender();
	}

	function ensureWidget(ui: ExtensionContext["ui"]): void {
		if (widgetActive) return;
		widgetActive = true;
		ui.setWidget(
			RUNS_WIDGET_KEY,
			(tui, theme) => {
				widgetTui = tui;
				return {
					render: (width: number) =>
						framedLines(
							widgetLines(
								[...runs.values()],
								paletteOf(theme),
								MAX_WIDGET_RUNS,
								pickerActive ? pickerRunId : null,
							),
							width,
							theme,
							"subagents",
						).map((line) => truncateToWidth(line, width)),
					invalidate: () => {
						// Renders fresh state on every call.
					},
					dispose: () => {
						widgetTui = null;
						widgetActive = false;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	/** Full-screen read-only view of a run's session, tailed from its session file. */
	async function openLiveViewer(ctx: ExtensionContext, run: Run, sessionFile: string): Promise<void> {
		if (ctx.mode !== "tui") return;
		const settings = pi.getSettings();
		await ctx.ui.custom<null>(
			(tui, theme, _keybindings, done) =>
				new LiveSessionViewer({
					tui,
					theme,
					run,
					sessionFile,
					cwd: ctx.cwd,
					outputPad: settings.outputPad ?? 1,
					hideThinkingBlock: settings.hideThinkingBlock ?? false,
					onClose: () => {
						done(null);
						// The overlay is gone, so the highlight comes back on this run.
						openPicker();
						touch();
					},
				}),
			{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 } },
		);
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new RunPickerEditor(tui, theme, keybindings, {
					refresh: touch,
					open: () => {
						const runId = pickerRunId;
						touch();
						const run = runId ? runs.get(runId) : undefined;
						if (!run) return;
						const sessionId = run.sessionId;
						if (!sessionId) {
							ctx.ui.notify(`${run.agent}: session not started yet`, "info");
							return;
						}
						const dir = run.sessionDir ?? subagentSessionDir(ctx.sessionManager.getSessionDir());
						void findSessionFile(dir, sessionId).then((sessionPath) => {
							if (!sessionPath) {
								ctx.ui.notify(`${run.agent}: session ${sessionId} not found`, "error");
								return;
							}
							// Viewing never switches sessions, so the main conversation and its
							// prompt stay exactly where they were.
							closePicker();
							touch();
							void openLiveViewer(ctx, run, sessionPath);
						});
					},
				}),
		);
		if (runs.size > 0) ensureWidget(ctx.ui);
	});

	pi.on("session_shutdown", () => {
		widgetTui = null;
		widgetActive = false;
		closePicker();
		runs.clear();
		pickerRunId = null;
		viewerPositions.clear();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context windows.",
			"Use { agent, task } for one subagent, or { tasks: [{ agent, task }, ...] } to run several in parallel.",
			"A task starting with /skill:<name> is expanded inside the subagent, which also reaches skills that are hidden from model discovery.",
			`Agents are loaded from ${path.join(getAgentDir(), "agents")}. Project agents in ${CONFIG_DIR_NAME}/agents require agentScope "both" or "project".`,
		].join(" "),
		promptSnippet: "Delegate a task to a specialized subagent with an isolated context window",
		promptGuidelines: [
			"Use the subagent tool for self-contained investigations (broad codebase search, multi-file review) when the main context should stay lean instead of reading every file directly.",
			"Use the subagent tool's tasks array when several independent investigations can run in parallel.",
			"Prefix a subagent task with /skill:<name> when the subagent must follow that skill, including skills marked disable-model-invocation that it cannot discover on its own.",
		],
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (single mode)" })),
			task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task to delegate to the agent" }),
						cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
					}),
					{ description: "{agent, task} pairs to run in parallel" },
				),
			),
			agentScope: Type.Optional(
				StringEnum(["user", "project", "both"] as const, {
					description: 'Which agent directories to use. Default: "user".',
					default: "user",
				}),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		}),

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const defaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const { agents } = discoverAgents(ctx.cwd, agentScope);
			const available = agents.map((agent) => agent.name).join(", ") || "none";

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			if (hasTasks === hasSingle) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode: { agent, task } or { tasks: [...] }.\nAvailable agents: ${available}`,
						},
					],
					details: { mode: "single", results: [] } satisfies SubagentDetails,
				};
			}

			clearFinishedRuns();
			ensureWidget(ctx.ui);

			if (hasTasks) {
				const tasks = params.tasks ?? [];
				if (tasks.length > MAX_PARALLEL_TASKS) {
					return {
						content: [{ type: "text", text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
						details: { mode: "parallel", results: [] } satisfies SubagentDetails,
					};
				}

				const jobs = tasks.map((task, index) => ({
					task,
					run: createRun(`${toolCallId}:${index}`, task.agent, task.task),
				}));
				touch();

				const results = await mapWithConcurrencyLimit(jobs, MAX_CONCURRENCY, async (job) => {
					const agent = agents.find((candidate) => candidate.name === job.task.agent);
					if (!agent) {
						return failedResult(job.run, job.task.agent, job.task.task, `Unknown agent. Available: ${available}`);
					}
					return runAgent({
						run: job.run,
						agent,
						task: job.task.task,
						cwd: job.task.cwd ? path.resolve(ctx.cwd, job.task.cwd) : ctx.cwd,
						sessionDir: subagentSessionDir(ctx.sessionManager.getSessionDir()),
						defaults,
						signal,
						onEvent: touch,
					});
				});

				const successCount = results.filter((result) => !isFailedResult(result)).length;
				const summaries = results.map((result) => {
					const status = isFailedResult(result) ? `failed (${result.stopReason ?? "error"})` : "completed";
					return `### [${result.agent}] ${status}\n\n${truncateParallelOutput(getResultOutput(result))}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: { mode: "parallel", results } satisfies SubagentDetails,
				};
			}

			const run = createRun(toolCallId, params.agent ?? "unknown", params.task ?? "");
			const onEvent = (): void => touch();
			touch();
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				const message = `Unknown agent "${params.agent}". Available: ${available}`;
				return {
					content: [{ type: "text", text: message }],
					details: {
						mode: "single",
						results: [failedResult(run, params.agent ?? "unknown", params.task ?? "", message)],
					} satisfies SubagentDetails,
				};
			}

			const result = await runAgent({
				run,
				agent,
				task: params.task ?? "",
				cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
				sessionDir: subagentSessionDir(ctx.sessionManager.getSessionDir()),
				defaults,
				signal,
				onEvent,
			});
			return {
				content: [
					{
						type: "text",
						text: isFailedResult(result)
							? `${result.stopReason ?? "failed"}: ${getResultOutput(result)}`
							: getFinalOutput(result.messages) || "(no output)",
					},
				],
				details: { mode: "single", results: [result] } satisfies SubagentDetails,
			};
		},

		renderCall(args, theme, _context) {
			const scope = args.agentScope ?? "user";
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length})`) +
					theme.fg("muted", ` [${scope}]`);
				for (const task of args.tasks.slice(0, 3)) {
					text += `\n  ${theme.fg("accent", task.agent)}${theme.fg("dim", ` ${preview(task.task, 50)}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `… +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}

			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", args.agent ?? "…") +
				theme.fg("muted", ` [${scope}]`) +
				`\n  ${theme.fg("dim", preview(args.task ?? "…", 60))}`;
			return new Text(text, 0, 0);
		},

	});
}
