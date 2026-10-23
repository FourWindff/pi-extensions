/** Run with Pi's jiti aliases; see README.md. No model calls or terminal required. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import modeSwitching from "../mode-switching/index.ts";
import lastUserMessage from "./index.ts";

async function check(): Promise<void> {
	const handlers = new Map<string, Function[]>();
	const shortcuts: Function[] = [];
	let factory: any;
	let editor: any;
	let branch: any[] = [];
	let renders = 0;
	let color = "90";
	const tui: any = { terminal: { rows: 40 }, requestRender: () => renders++ };
	const theme: any = {
		borderColor: (text: string) => text,
		fg: (_token: string, text: string) => `\x1b[${color}m${text}\x1b[0m`,
	};
	const keybindings: any = { matches: () => false };
	const ctx: any = {
		mode: "tui",
		cwd: "/tmp/pi-preview",
		sessionManager: { getBranch: () => branch },
		ui: {
			theme,
			getEditorComponent: () => factory,
			setEditorComponent: (next: any) => { factory = next; editor = next(tui, theme, keybindings); },
			setFooter: () => {},
			notify: () => {},
		},
	};
	const pi: any = {
		on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerShortcut: (_key: string, options: any) => shortcuts.push(options.handler),
		getAllTools: () => [],
		getActiveTools: () => [],
		setActiveTools: () => {},
		appendEntry: () => {},
	};
	const emit = async (name: string, event: any = {}) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};
	const user = (content: any) => ({ role: "user", content, timestamp: 0 });
	const top = (width = 100, hidden = 0) => stripTerminalSequences(editor.renderTopBorder(width, hidden));

	lastUserMessage(pi);
	await emit("session_start");
	assert.equal(editor instanceof CustomEditor, true, "standalone extension preserves the native editor");
	assert.equal(top(), "─".repeat(100), "no previous user message means no preview");

	await emit("message_start", { message: user("First\nsecond\tthird") });
	assert.equal(top().slice(57, 97), "First second third".padStart(40), "short previews align right");
	assert.ok(top().endsWith("third ──"), "preview ends with a space and two border dashes");
	assert.ok(renders > 0, "message updates request a render");
	await emit("message_start", { message: { role: "assistant", content: [] } });
	assert.ok(top().includes("First second third"), "assistant output does not replace the preview");

	const shortWideText = "\u4e2d\u6587\u{1f600}";
	await emit("message_start", { message: user(shortWideText) });
	for (let width = 52; width <= 180; width++) {
		const line = top(width);
		assert.ok(line.endsWith(`${shortWideText} ──`), "wide text keeps the same right margin after resize");
		assert.equal(visibleWidth(line), width);
	}

	const wideText = shortWideText.repeat(30);
	await emit("message_start", { message: user(wideText) });
	for (let width = 0; width <= 180; width++) {
		assert.equal(visibleWidth(top(width)), width, `border fits ${width} columns`);
	}
	assert.ok(top().includes("…"), "long wide text is truncated");
	assert.equal(top(50), "─".repeat(50), "tiny windows keep the native border");
	color = "91";
	assert.ok(editor.renderTopBorder(100, 0).includes("\x1b[91m"), "theme colors are read at render time");

	await emit("message_start", { message: user("\x1b[31mred\x1b[0m\x1b]0;title\x07\x00\x08") });
	assert.equal(top().slice(57, 97), "red".padStart(40), "terminal escapes and control bytes are stripped");
	await emit("message_start", { message: user([{ type: "image", data: "", mimeType: "image/png" }]) });
	assert.ok(top().includes("[image]"), "image-only messages replace the old text");

	branch = [{ type: "message", message: user("restored branch") }];
	await emit("session_tree");
	assert.ok(top().includes("restored branch"));
	branch = [];
	await emit("session_tree");
	assert.equal(top(), "─".repeat(100), "empty branches clear the preview");
	await emit("session_shutdown");

	// Match package order: an existing editor, mode-switching, then the preview.
	handlers.clear();
	factory = (t: any, th: any, kb: any) => new CustomEditor(t, th, kb, { embedWorkingStatus: true });
	modeSwitching(pi);
	lastUserMessage(pi);
	branch = [{ type: "message", message: user("resume preview") }];
	await emit("session_start");
	await delay(5); // mode-switching re-wraps the editor once startup settles
	const settledFactory = factory;
	for (let i = 0; i < 5; i++) await emit("turn_start");
	assert.equal(factory, settledFactory, "turns do not stack editor decorators");
	assert.ok(top().includes("resume preview"), "startup wrapping retains the preview");
	editor.setWorkingStatusIndicator({
		renderInBorder: (width: number) => truncateToWidth("* Working (esc to interrupt)", width, ""),
		renderSpinnerInBorder: () => "*",
	});
	assert.ok(top().includes("Working (esc to interrupt)"), "working status survives");
	assert.equal(top().slice(-3), [...top().slice(0, 3)].reverse().join(""), "preview margin mirrors the working status prefix");
	assert.ok(top(100, 3).includes("3 more"), "scroll overflow remains visible");
	for (const mode of ["build", "plan", "ask"]) {
		if (mode !== "build") await shortcuts[0]!(ctx);
		const bottom = stripTerminalSequences(editor.renderBottomBorder(100, 0));
		assert.equal(bottom.slice(0, 3), top().slice(0, 3), "both borders start with the same two dashes and space");
		assert.equal(bottom.indexOf(mode), top().indexOf("*"), "mode starts below the working status block");
		assert.ok(bottom.includes("/tmp/pi-preview"), "directory stays next to the mode");
		for (let width = 0; width < 120; width++) {
			assert.equal(visibleWidth(editor.renderBottomBorder(width, 0)), width);
		}
	}
	await emit("session_shutdown");

	factory = undefined;
	ctx.mode = "json";
	await emit("session_start");
	await emit("message_start", { message: user("not interactive") });
	assert.equal(factory, undefined, "non-TUI sessions are untouched");
	console.log("pi-lastssermessage: preview, editor composition and mode alignment checks passed");
}

void check();
