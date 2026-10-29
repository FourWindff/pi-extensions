import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Use the same installed packages and extension loader as pi, without local dependencies.
const install = join(homedir(), ".pi/agent/install");
const agentDir = process.env.PI_TEST_CODING_AGENT_DIR ?? join(
	install,
	"releases",
	readFileSync(join(install, "current-version"), "utf8").trim(),
	"node_modules/@earendil-works/pi-coding-agent",
);
const fromAgent = createRequire(join(agentDir, "package.json"));
const { Container, CURSOR_MARKER, getKeybindings, KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, TuiMainScreen } = await import(
	pathToFileURL(fromAgent.resolve("@earendil-works/pi-tui"))
);
const { loadExtensions } = await import(pathToFileURL(join(agentDir, "dist/core/extensions/loader.js")));
const { createChatViewport } = await import(pathToFileURL(join(agentDir, "dist/modes/interactive/chat-viewport.js")));
const { initTheme, theme } = await import(pathToFileURL(join(agentDir, "dist/modes/interactive/theme/theme.js")));
initTheme();

const directory = dirname(fileURLToPath(import.meta.url));
const loaded = await loadExtensions([join(directory, "index.ts")], directory);
assert.deepEqual(loaded.errors, []);
const tool = loaded.extensions[0]?.tools.get("ask_user")?.definition;
assert.ok(tool, "pi must load the ask_user tool");

const ENTER = "\r";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

class TestTerminal {
	constructor(columns, rows) {
		this.columns = columns;
		this.rows = rows;
		this.kittyProtocolActive = false;
	}
	start(onInput, onResize) {
		this.onInput = onInput;
		this.onResize = onResize;
	}
	stop() {}
	write(_data) {}
	hideCursor() {}
	showCursor() {}
	input(data) {
		assert.ok(this.onInput, "terminal must be started");
		this.onInput(data);
	}
	resize(columns, rows = this.rows) {
		this.columns = columns;
		this.rows = rows;
		this.onResize();
	}
}

function text(lines) {
	return {
		render: () => lines,
		invalidate() {},
	};
}

// This is the host side of ctx.ui.custom: dock in the editor slot or a real overlay.
class FormHarness {
	constructor(columns = 64, rows = 18, mode = "fullscreen", keybindings = getKeybindings()) {
		this.keybindings = keybindings;
		this.terminal = new TestTerminal(columns, rows);
		this.tui = mode === "regular"
			? new TuiMainScreen(this.terminal, false)
			: new TuiAltScreen(this.terminal, false, undefined, { mouse: false });
		this.document = new Container();
		this.document.addChild(text(Array.from({ length: 24 }, (_, i) => `TRANSCRIPT-${i + 1}`)));
		this.editor = text(["EDITOR"]);
		this.dock = new Container();
		this.dock.addChild(this.editor);
		const pendingMessages = new Container();
		const status = new Container();
		const widgetsAbove = new Container();
		const widgetsBelow = new Container();
		const footer = new Container();
		footer.addChild(text(["FOOTER"]));
		const { root } = createChatViewport({
			document: this.document,
			pendingMessages,
			status,
			widgetsAbove,
			editor: this.dock,
			widgetsBelow,
			footer,
		});
		for (const component of [this.document, pendingMessages, status, widgetsAbove, this.dock, widgetsBelow, footer]) {
			this.tui.addChild(component);
		}
		if (mode === "fullscreen") this.tui.setLayoutRoot(root);
		this.tui.setFocus(this.editor);
		this.tui.start();
		this.tui.renderNow();
		this.mounted = new Promise((resolve, reject) => {
			this.resolveMounted = resolve;
			this.rejectMounted = reject;
		});
	}

	custom = (factory, options) => new Promise((resolve, reject) => {
		let component;
		let overlay;
		let closed = false;
		const isOverlay = options?.overlay ?? false;
		const done = (result) => {
			if (closed) return;
			closed = true;
			if (isOverlay) overlay?.hide();
			else {
				this.dock.clear();
				this.dock.addChild(this.editor);
				this.tui.setFocus(this.editor);
				this.tui.requestRender();
			}
			resolve(result);
			component?.dispose?.();
		};
		try {
			Promise.resolve(factory(this.tui, theme, this.keybindings, done)).then((created) => {
				if (closed) return;
				component = created;
				if (isOverlay) {
					const overlayOptions = typeof options.overlayOptions === "function"
						? options.overlayOptions()
						: options.overlayOptions ?? (component.width ? { width: component.width } : undefined);
					overlay = this.tui.showOverlay(component, overlayOptions);
					options.onHandle?.(overlay);
				} else {
					this.dock.clear();
					this.dock.addChild(component);
					this.tui.setFocus(component);
					this.tui.requestRender();
				}
				this.tui.renderNow();
				this.resolveMounted({ component, overlay });
			}).catch((error) => {
				this.rejectMounted(error);
				reject(error);
			});
		} catch (error) {
			this.rejectMounted(error);
			reject(error);
		}
	});

	key(data) {
		this.terminal.input(data);
		this.tui.renderNow();
	}

	lines() {
		if (this.tui.mode === "fullscreen") return this.tui.getScreenLines().map(stripTerminalSequences);
		const { previousLines, previousViewportTop } = this.tui.captureRenderState();
		return previousLines.slice(previousViewportTop, previousViewportTop + this.terminal.rows).map(stripTerminalSequences);
	}

	screen() {
		return this.lines().join("\n");
	}

	stop() {
		this.tui.stop({ preserveScreen: true });
	}
}

async function openForm(t, questions, columns = 64, rows = 18, mode = "fullscreen", keybindings = getKeybindings()) {
	const harness = new FormHarness(columns, rows, mode, keybindings);
	const controller = new AbortController();
	const result = tool.execute("layout-test", { questions }, controller.signal, undefined, {
		mode: "tui",
		ui: { custom: harness.custom },
	});
	// Always release the real TUI and the pending form, including on assertion failure.
	t.after(() => {
		controller.abort();
		harness.stop();
	});
	await harness.mounted;
	return { harness, result };
}

function questions(count) {
	return Array.from({ length: count }, (_, i) => {
		const id = String(i + 1).padStart(2, "0");
		return { question: `ITEM-${id}?`, options: [`PICK-${id}-A`, `PICK-${id}-B`] };
	});
}

function answerQuestions(harness, count) {
	for (let i = 0; i < count; i++) {
		if (i % 2 === 1) harness.key(DOWN);
		harness.key(ENTER);
	}
}

function assertVisible(harness, value, message) {
	assert.ok(harness.screen().includes(value), `${message}\n${harness.screen()}`);
}

function assertSelected(harness, label) {
	assert.match(harness.screen(), new RegExp(`(?:>|\u2192|\u25b6)\\s*(?:\\d+\\.\\s*)?${label}`),
		`selected ${label} must be visible in the terminal\n${harness.screen()}`);
}

test("harness honors overlay options, focus, clipping, and the terminal input channel", { timeout: 5000 }, async (t) => {
	const harness = new FormHarness(40, 12);
	t.after(() => harness.stop());
	const received = [];
	let receivedHandle;
	const result = harness.custom((_tui, _theme, _keys, done) => ({
		render: () => Array.from({ length: 6 }, (_, i) => `OVERLAY-${i}`),
		invalidate() {},
		handleInput(data) {
			received.push(data);
			if (data === ENTER) done("closed");
		},
	}), {
		overlay: true,
		overlayOptions: () => ({ width: "50%", maxHeight: "25%", row: 2, col: 4 }),
		onHandle: (handle) => { receivedHandle = handle; },
	});
	const { component, overlay } = await harness.mounted;
	assert.equal(receivedHandle, overlay);
	assert.ok(overlay.isFocused());
	assert.equal(harness.tui.getFocusedComponent(), component);
	assert.deepEqual(overlay.getBounds(), { row: 2, col: 4, width: 20, height: 3 });
	assertVisible(harness, "OVERLAY-2", "the clipped overlay should be visible");
	assert.ok(!harness.screen().includes("OVERLAY-3"), "maxHeight must clip the overlay");
	const transcriptTop = harness.tui.viewportTop;
	harness.key(PAGE_UP);
	assert.equal(harness.tui.viewportTop, transcriptTop, "the focused overlay must own PageUp");
	harness.key(ENTER);
	assert.deepEqual(received, [PAGE_UP, ENTER]);
	assert.equal(await result, "closed");
	assert.equal(harness.tui.hasOverlay(), false);
	assert.equal(harness.tui.getFocusedComponent(), harness.editor);
});

test("the eighth active question and its selection remain visible after seven answers", { timeout: 5000 }, async (t) => {
	const { harness } = await openForm(t, questions(12));
	answerQuestions(harness, 7);
	assertVisible(harness, "ITEM-08?", "the eighth active question must be on screen");
	assertSelected(harness, "PICK-08-A");
});

test("review of twelve questions scrolls from first to last with PageUp and PageDown", { timeout: 5000 }, async (t) => {
	const items = questions(12).map((q) => ({
		...q,
		question: `${q.question} Please review this deliberately long question after the answers are complete.`,
	}));
	const { harness, result } = await openForm(t, items);
	answerQuestions(harness, 12);
	for (let i = 0; i < 12; i++) harness.key(PAGE_DOWN);
	assertVisible(harness, "ITEM-12?", "PageDown must reveal the last reviewed question");
	assertVisible(harness, "PICK-12-B", "the last reviewed answer must be visible");
	assert.ok(!harness.screen().includes("ITEM-01?"), "the first question should be above the bottom of the review");
	for (let i = 0; i < 12; i++) harness.key(PAGE_UP);
	assertVisible(harness, "ITEM-01?", "PageUp must reveal the first reviewed question");
	assertVisible(harness, "PICK-01-A", "the first reviewed answer must be visible");
	assert.ok(!harness.screen().includes("ITEM-12?"), "the last question should be below the top of the review");
	for (let i = 0; i < 12; i++) harness.key(PAGE_DOWN);
	assertVisible(harness, "ITEM-12?", "PageDown must reveal the last question again");
	harness.key(ENTER);
	assert.deepEqual((await result).details.answers, items.map((q, i) => q.options[i % 2]));
});

test("Enter on review returns the twelve actual question and answer pairs", { timeout: 5000 }, async (t) => {
	const items = questions(12);
	const { harness, result } = await openForm(t, items);
	let finished = false;
	result.then(() => { finished = true; }, () => { finished = true; });
	answerQuestions(harness, 12);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(finished, false, "the review must wait for the final Enter");
	harness.key(ENTER);
	const output = await result;
	assert.deepEqual(output.details.answers, items.map((q, i) => q.options[i % 2]));
	assert.equal(output.content[0].text, items.map((q, i) => `Q: ${q.question}\nA: ${q.options[i % 2]}`).join("\n\n"));
});

test("a long choice list follows the highlighted option in both directions", { timeout: 5000 }, async (t) => {
	const options = Array.from({ length: 14 }, (_, i) =>
		`OPTION-${String(i + 1).padStart(2, "0")} with a long description that wraps on a narrow terminal`);
	const { harness, result } = await openForm(t, [{ question: "Choose an option?", options }], 52, 16);
	for (let i = 1; i < 10; i++) {
		harness.key(DOWN);
		assertSelected(harness, `OPTION-${String(i + 1).padStart(2, "0")}`);
	}
	for (let i = 8; i >= 1; i--) {
		harness.key(UP);
		assertSelected(harness, `OPTION-${String(i + 1).padStart(2, "0")}`);
	}
	for (let i = 0; i < 8; i++) harness.key(DOWN);
	harness.key(ENTER);
	harness.key(ENTER);
	assert.deepEqual((await result).details.answers, [options[9]]);
});

test("the active question stays visible when navigating a long list", { timeout: 5000 }, async (t) => {
	const options = Array.from({ length: 10 }, (_, i) => `OPTION-${i + 1}`);
	const { harness } = await openForm(t, [{ question: "Which database?", options }], 40, 8);
	for (let i = 0; i < 7; i++) {
		harness.key(DOWN);
		assertSelected(harness, `OPTION-${i + 2}`);
		assertVisible(harness, "Which database?", "the current question must remain visible above the selected option");
	}
});

test("printable custom paging shortcuts do not swallow editor input", { timeout: 5000 }, async (t) => {
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.pageDown": "j", "tui.select.pageUp": "k" });
	const { harness, result } = await openForm(t, [{ question: "Answer?" }], 40, 8, "fullscreen", keys);
	for (const char of "java") harness.key(char);
	harness.key("\x1b[106u");
	harness.key(ENTER);
	harness.key(ENTER);
	assert.deepEqual((await result).details.answers, ["javaj"]);
});

test("default paging remains available with printable custom bindings", { timeout: 5000 }, async (t) => {
	const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.pageDown": "j", "tui.select.pageUp": "k" });
	const items = [{ question: "Type here?" }, ...questions(12)];
	const { harness } = await openForm(t, items, 40, 8, "fullscreen", keys);
	for (let i = 0; i < 30; i++) harness.key(PAGE_DOWN);
	assertVisible(harness, "ITEM-12?", "PageDown must still scroll the form while editing");
	harness.key("j");
	assertVisible(harness, "j", "a printable paging binding must still be typed in the editor");
});

test("wide characters in options remain reachable on a five-column screen", { timeout: 5000 }, async (t) => {
	const option = "\u4e2d\u6587\u9009\u9879";
	const { harness } = await openForm(t, [{ question: "Pick?", options: [option] }], 5, 7);
	let seen = "";
	for (let i = 0; i < 30; i++) {
		seen += harness.screen();
		harness.key(PAGE_DOWN);
	}
	for (const char of option) assert.ok(seen.includes(char), `${char} must not be clipped`);
});

test("a Chinese question reflows when the terminal becomes wider", { timeout: 5000 }, async (t) => {
	const prompt = "\u4e2d\u6587\u9898\u76ee\u6d4b\u8bd5".repeat(4);
	const { harness } = await openForm(t, [{ question: prompt, options: ["one", "two"] }], 28, 18);
	const narrow = harness.lines();
	assert.ok(narrow.join("").replace(/\s/g, "").includes(prompt), "the narrow screen must contain the whole wrapped question");
	assert.ok(!narrow.some((line) => line.includes(prompt)), "the question should wrap at the initial width");
	harness.terminal.resize(80);
	harness.tui.renderNow();
	assert.ok(harness.lines().some((line) => line.includes(prompt)),
		`the wider screen must reflow the question onto one line\n${harness.screen()}`);
});

test("mouse wheel scrolls the review rather than the transcript", { timeout: 5000 }, async (t) => {
	const { harness, result } = await openForm(t, questions(12), 60, 12);
	answerQuestions(harness, 12);
	const transcriptTop = harness.tui.viewportTop;
	for (let i = 0; i < 50; i++) harness.key("\x1b[<65;2;2M");
	assertVisible(harness, "ITEM-12?", "wheel down must reach the end of the review");
	assert.equal(harness.tui.viewportTop, transcriptTop);
	for (let i = 0; i < 50; i++) harness.key("\x1b[<64;2;2M");
	assertVisible(harness, "ITEM-01?", "wheel up must reach the beginning of the review");
	assert.equal(harness.tui.viewportTop, transcriptTop);
	harness.key(ENTER);
	assert.equal((await result).details.answers.length, 12);
});

test("the selection remains visible when the terminal height shrinks", { timeout: 5000 }, async (t) => {
	const options = Array.from({ length: 12 }, (_, i) => `OPTION-${String(i + 1).padStart(2, "0")}`);
	const { harness } = await openForm(t, [{ question: "Choose?", options }], 40, 20);
	for (let i = 0; i < 9; i++) harness.key(DOWN);
	harness.terminal.resize(40, 5);
	harness.tui.renderNow();
	assertSelected(harness, "OPTION-10");
	harness.terminal.resize(40, 20);
	harness.tui.renderNow();
	assertSelected(harness, "OPTION-10");
});

test("typing after scrolling restores the Chinese editor cursor and preserves the answer", { timeout: 5000 }, async (t) => {
	const items = [...questions(8), { question: "Free text?" }, ...questions(3)];
	const { harness, result } = await openForm(t, items, 48, 10);
	answerQuestions(harness, 8);
	harness.key("\u4f60\u597d");
	assertVisible(harness, "\u4f60\u597d", "typed text must be visible");
	for (let i = 0; i < 8; i++) harness.key(PAGE_UP);
	assertVisible(harness, "ITEM-01?", "manual scroll must reach earlier questions");
	harness.key("!");
	assertVisible(harness, "\u4f60\u597d!", "typing must follow the editor cursor again");
	const { component } = await harness.mounted;
	assert.ok(component.render(48).some((line) => line.includes(CURSOR_MARKER)), "the editor must expose the IME cursor marker");
	harness.key(ENTER);
	answerQuestions(harness, 3);
	harness.key(ENTER);
	assert.equal((await result).details.answers[8], "\u4f60\u597d!");
});

test("a long active question can be read from beginning to end", { timeout: 5000 }, async (t) => {
	const prompt = `LONG-START ${"wrapped question content ".repeat(35)} LONG-END`;
	const { harness, result } = await openForm(t, [{ question: prompt, options: ["yes", "no"] }], 40, 8);
	for (let i = 0; i < 30; i++) harness.key(PAGE_UP);
	assertVisible(harness, "LONG-START", "the beginning of a long question must be reachable");
	for (let i = 0; i < 30; i++) harness.key(PAGE_DOWN);
	assertVisible(harness, "LONG-END", "the end of a long question must be reachable");
	assertSelected(harness, "yes");
	harness.key(ENTER);
	harness.key(ENTER);
	assert.deepEqual((await result).details.answers, ["yes"]);
});

test("back from review preserves the typed and selected answers", { timeout: 5000 }, async (t) => {
	const items = [
		{ question: "First?", options: ["A", "B"] },
		{ question: "Text?" },
		{ question: "Last?", options: ["C", "D"] },
	];
	const { harness, result } = await openForm(t, items, 40, 7);
	harness.key(DOWN);
	harness.key(ENTER);
	harness.key("hello");
	harness.key(ENTER);
	harness.key(ENTER);
	harness.key(ESCAPE);
	assertSelected(harness, "C");
	harness.key(ESCAPE);
	assertVisible(harness, "hello", "the typed answer must be restored when moving back");
	harness.key(ENTER);
	harness.key(ENTER);
	harness.key(ENTER);
	assert.deepEqual((await result).details.answers, ["B", "hello", "C"]);
});

test("escape on the first question cancels and closes the overlay", { timeout: 5000 }, async (t) => {
	const { harness, result } = await openForm(t, questions(12), 40, 7);
	harness.key(ESCAPE);
	assert.equal((await result).details.cancelled, true);
	assert.equal(harness.tui.hasOverlay(), false);
});

test("regular mode also supports focus following and review paging", { timeout: 5000 }, async (t) => {
	const items = questions(12);
	const { harness, result } = await openForm(t, items, 60, 12, "regular");
	answerQuestions(harness, 7);
	assertSelected(harness, "PICK-08-A");
	answerQuestions(harness, 5);
	for (let i = 0; i < 12; i++) harness.key(PAGE_DOWN);
	assertVisible(harness, "ITEM-12?", "PageDown must reach the end in regular mode");
	for (let i = 0; i < 12; i++) harness.key(PAGE_UP);
	assertVisible(harness, "ITEM-01?", "PageUp must reach the beginning in regular mode");
	harness.key(ENTER);
	assert.equal((await result).details.answers.length, 12);
});

test("the form is a fixed-height panel docked at the bottom", { timeout: 5000 }, async (t) => {
	// Must match PANEL_ROWS in index.ts.
	const PANEL_ROWS = 14;
	for (const [rows, panelRows] of [[18, PANEL_ROWS], [10, 10]]) {
		for (const mode of ["fullscreen", "regular"]) {
			const { harness } = await openForm(t, [{ question: "Only one?", options: ["yes", "no"] }], 64, rows, mode);
			const lines = harness.lines();
			const where = `${mode} ${rows}x64`;
			assert.equal(lines.length, rows, `${where}: the terminal keeps its rows`);
			assert.match(lines.at(-1) ?? "", /Question 1\/1/u, `${where}: the status line belongs on the last row`);
			const panelStart = lines.findIndex((line) => line.includes("\u2500"));
			assert.equal(panelStart, rows - panelRows, `${where}: the panel keeps a fixed height at the bottom\n${harness.screen()}`);
			if (rows > panelRows) {
				assert.ok(lines.slice(0, panelStart).some((line) => line.includes("TRANSCRIPT-")),
					`${where}: the transcript stays visible above the panel\n${harness.screen()}`);
			}
			assert.ok(!lines.slice(panelStart).some((line) => line.includes("TRANSCRIPT-")),
				`${where}: no transcript may show inside the panel\n${harness.screen()}`);
		}
	}
});
