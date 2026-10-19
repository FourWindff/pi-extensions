/**
 * Self-check for the aurora curtain.
 *   node ~/.pi/agent/extensions/aurora-line/check.ts
 *
 * The rendering checks always run; the wiring check at the end needs pi's module aliases, so it is
 * skipped under plain node and runs when the script is executed by pi's jiti loader.
 * A leaked frame timer would keep the process alive, so this also fails on bad cleanup.
 */

import assert from "node:assert/strict";
import {
	auroraRow,
	auroraRows,
	FALLBACK_BG,
	OSC11_QUERY,
	parseBackgroundReply,
	patchMouseGates,
	PULSE_FRAMES,
	restoreMouseGates,
	xterm256,
	type Rgb,
} from "./aurora.ts";

const ESCAPE = "\x1b";
const SGR = /\x1b\[[0-9;]*m/g;
const cells = (line: string) => line.replace(SGR, "").length;
/** Every background colour the row paints, in order. */
const colors = (line: string): Rgb[] =>
	[...line.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb);
const luminance = (color: Rgb) => Math.hypot(...color);
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
const spread = (values: number[]) => Math.sqrt(mean(values.map((v) => (v - mean(values)) ** 2))) / mean(values);
const profile = (line: string) => colors(line).map(luminance);
/**
 * Per-cell background colours, aligned to columns: undefined where the curtain paints nothing. The
 * `colors()` list above skips repeated colours, so it must not be indexed by column.
 */
const rowCells = (line: string): (Rgb | undefined)[] => {
	const out: (Rgb | undefined)[] = [];
	let current: Rgb | undefined;
	for (let i = 0; i < line.length; ) {
		if (line[i] === ESCAPE) {
			const sgr = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
			if (sgr) {
				const params = sgr[1]!.split(";").map(Number);
				if (params[0] === 48 && params[1] === 2) current = [params[2]!, params[3]!, params[4]!];
				else if (params.some((code) => code === 49 || code === 0)) current = undefined;
				i += sgr[0].length;
				continue;
			}
			i += 2;
			continue;
		}
		out.push(current);
		i += 1;
	}
	return out;
};
/** Luminance per column, with unpainted cells counting as background. */
const rowProfile = (line: string) => rowCells(line).map((cell) => (cell === undefined ? 0 : luminance(cell)));
/** A column slice of a row, used for the shape checks. */
const core = (values: number[]) => values.slice(12, -12);
const black: Rgb = [0, 0, 0];
const text = (width: number, rows: number, frame: number, extra: object = {}) =>
	auroraRows({ width, rows, frame, mode: "text", bg: black, ...extra });

// --- the curtain ------------------------------------------------------------

const curtain = text(200, 5, 0);
assert.equal(curtain.length, 5, "one line per row");
for (const line of curtain) {
	assert.equal(cells(line), 200, "each row is exactly `width` cells wide");
	assert.ok(line.endsWith("\x1b[0m"));
}
assert.deepEqual(text(0, 5, 0), []);
assert.deepEqual(text(80, 0, 0), []);

// Nothing but white and grey: every cell has equal channels.
for (const line of curtain) {
	for (const [r, g, b] of colors(line)) {
		assert.deepEqual([r, g], [b, b], "the curtain must stay colourless");
	}
}

// Brightest row hugs the input box, the far end thins out into the haze.
const near = profile(curtain[4]!);
const far = profile(curtain[0]!);
assert.ok(mean(near) > mean(far) * 2, "the brightest row must sit on the input box");
// The far end breaks into rays: measured per cell, not per colour run, because a smoothed row is one
// long run even where its cells differ by a third.
const texture = (line: string) => spread(core(rowCells(line).map((cell) => (cell ? luminance(cell) : 0))));
const hazeTextures = [0, 1, 2].map((y) => texture(curtain[y]!));
assert.ok(
	Math.max(...hazeTextures) > 0.3,
	`the haze must break into rays (${hazeTextures.map((value) => value.toFixed(2)).join(", ")})`,
);
assert.ok(texture(curtain[4]!) < Math.max(...hazeTextures), "the core is smoother than the haze");
assert.ok(Math.min(...core(near)) > Math.max(...core(near)) * 0.3, "the core must stay unbroken");
// The band's outermost row must not land as a lit line: that edge is where the wash met the untinted
// transcript above it, and it read as a cut. A third of the core row is the most it may carry.
const rowWash = (line: string) => mean(rowCells(line).map((cell) => (cell ? luminance(cell) : 0)));
assert.ok(
	rowWash(curtain[0]!) < rowWash(curtain[4]!) * 0.3,
	`the outer row must trail off (${rowWash(curtain[0]!).toFixed(1)} of ${rowWash(curtain[4]!).toFixed(1)})`,
);

// Mirrored curtain for the top of the window: the core moves to the first row.
const flipped = text(200, 5, 0, { flip: true });
assert.ok(mean(profile(flipped[0]!)) > mean(profile(flipped[4]!)) * 2, "the top curtain is the bottom one mirrored");

// The curtain spans the whole width and has a height: the core row never breaks, the far edge rises
// and falls, and both travel with time.
const heights = (frame: number, width = 160) => {
	const rows = text(width, 5, frame).map(rowCells);
	const value = (cell: Rgb | undefined) => (cell ? luminance(cell) : 0);
	// The wash is smoothed across cells, so a painted cell no longer marks the far edge: a row counts
	// as curtain when it carries 40% of the column's own core wash, which keeps the count independent
	// of how the band is shaded.
	return Array.from({ length: width }, (_, x) => {
		const core = value(rows[4]![x]);
		return core <= 1 ? 0 : rows.filter((row) => value(row[x]) > core * 0.4).length;
	});
};
const now = heights(0);
assert.ok(Math.min(...now) >= 1, "every column keeps its core row");
// How far the far edge reaches moves from frame to frame, so one snapshot can sit at a quiet moment.
const spans = [0, 30, 60, 90].map((frame) => {
	const counts = heights(frame);
	return [Math.min(...counts), Math.max(...counts)] as const;
});
assert.ok(
	spans.some(([min, max]) => max - min >= 2),
	`the far edge must rise and fall (${spans.map(([min, max]) => `${min}..${max}`).join(" ")})`,
);
assert.ok(
	spans.some(([, max]) => max === 5),
	"some columns must reach the far end of the band",
);
assert.ok(now.some((height, x) => height !== heights(60)[x]), "the undulation must travel");

// The far edge is a frayed, graded line: its brightness steps in small increments instead of
// switching a whole row on and off, which is what made the undulation look coarse.
const topEdge = rowProfile(curtain[0]!);
const levels = new Set(topEdge.map((value) => Math.round(value))).size;
const steps = topEdge.slice(1).map((value, x) => Math.abs(value - topEdge[x]!));
const range = Math.max(...topEdge) - Math.min(...topEdge);
assert.ok(levels > 8, `the far edge must fade, not switch (found ${levels} levels)`);
assert.ok(
	Math.max(...steps) < range * 0.4,
	`the far edge must step in small increments (largest ${Math.max(...steps).toFixed(1)} of ${range.toFixed(1)})`,
);

// Smoothness, both ways. Sideways: neighbouring cells have to land on close greys or the curtain
// reads as a grid of squares (7.5% of the column steps used to jump by more than 12 of 255, 0.1%
// after the wash is blurred across the band). Down the rows: no row may jump from background to
// bright (the unblurred fringe did, by 163 of 255).
const cellRows = text(200, 5, 0).map(rowCells);
const value = (cell: Rgb | undefined) => luminance(cell ?? black);
const columnSteps = cellRows.flatMap((row) => row.slice(1).map((cell, x) => Math.abs(value(cell) - value(row[x]))));
const hard = columnSteps.filter((step) => step > 12).length / columnSteps.length;
assert.ok(hard < 0.02, `neighbouring cells must not step in squares (${(hard * 100).toFixed(1)}% hard steps)`);
const rowSteps = cellRows
	.slice(1)
	.flatMap((row, y) => row.map((cell, x) => Math.abs(value(cell) - value(cellRows[y]![x]))));
assert.ok(
	Math.max(...rowSteps) < 90,
	`no row may jump out of the background (largest row step ${Math.max(...rowSteps).toFixed(0)} of 255)`,
);

// No gap at the left or right screen edge, and no systematic dimming there either.
const edgeFrames = Array.from({ length: 12 }, (_, i) => i * 5);
const coreRows = edgeFrames.map((frame) => rowCells(text(200, 5, frame)[4]!));
const coreValue = (cell: Rgb | undefined) => (cell === undefined ? 0 : luminance(cell));
const rowMean = mean(coreRows.flat().map(coreValue));
assert.ok(
	mean(coreRows.map((row) => mean(row.slice(0, 4).map(coreValue)))) > rowMean * 0.6,
	"the curtain must reach the left edge",
);
assert.ok(
	mean(coreRows.map((row) => mean(row.slice(-4).map(coreValue)))) > rowMean * 0.6,
	"the curtain must reach the right edge",
);
assert.ok(
	coreRows.every((row) => row.every((cell) => cell !== undefined)),
	"the core row must have no cell left at the background",
);

// It moves: 40 frames later the rays have travelled on.
const base = rowProfile(curtain[4]!);
const later = rowProfile(text(200, 5, 40)[4]!);
assert.equal(base.length, later.length, "the rows must stay column aligned");
assert.ok(mean(base.map((v, i) => Math.abs(v - later[i]!))) > mean(base) * 0.15, "the curtain must travel");
assert.ok(Math.abs(mean(base) - mean(later)) < mean(base) * 0.5, "travelling must not mean flickering");

// Breathing: over one full cycle the whole curtain runs dim, bright and back again.
const cycle = Array.from({ length: PULSE_FRAMES / 4 + 1 }, (_, i) => mean(text(200, 5, i * 4).flatMap(profile)));
const dimmest = Math.min(...cycle);
assert.ok(
	Math.max(...cycle) > dimmest * 1.1,
	`the curtain must breathe (${dimmest.toFixed(1)} to ${Math.max(...cycle).toFixed(1)})`,
);

// A wash, not a wall: no cell may go opaque, or the text on top drowns.
assert.ok(Math.max(...curtain.flatMap(profile)) < 0.85 * 255, "the wash must not go opaque");

// Dissolving: half the opacity is half the glow.
const fading = profile(text(200, 5, 0, { opacity: 0.5 })[4]!);
assert.ok(Math.abs(mean(fading) - mean(near) / 2) < mean(near) * 0.05, "opacity must scale the glow");

// Thinking is the same curtain, dimmer.
const thinking = auroraRows({ width: 200, rows: 5, frame: 0, mode: "think", bg: black }).flatMap(profile);
assert.ok(mean(thinking) < mean(curtain.flatMap(profile)) * 0.85, "thinking must be dimmer");

// --- transparency over the transcript --------------------------------------

const behind = "const answer = 42;";
const [tinted] = text(60, 1, 100, { underlying: [behind] });
assert.ok(tinted!.includes("48;2;"), "the curtain must still paint its background");
assert.ok(tinted!.replace(SGR, "").startsWith(behind), "the text under the curtain must survive");
assert.equal(tinted!.replace(SGR, "").length, 60, "the tinted row covers the full width");

// A reset in the underlying line must not switch the curtain off.
const [reset] = text(20, 1, 100, { underlying: ["a\x1b[0mb"] });
assert.ok(reset!.includes("\x1b[0m\x1b[48;2;"), "the background must be re-applied after a reset");

// A tool panel keeps its colour and the curtain is added on top of it.
const [panel] = text(40, 1, 100, { underlying: ["plain \x1b[48;2;10;200;80mpanel\x1b[49m tail"] });
const panelBody = /\x1b\[48;2;10;200;80m([\s\S]*?)\x1b\[49m/.exec(panel!)?.[1] ?? "";
const panelColors = [...panelBody.matchAll(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g)].map((m) => [+m[1]!, +m[2]!, +m[3]!] as Rgb);
assert.ok(panelBody.replace(SGR, "").includes("panel"), "the panel text must survive");
assert.ok(panelColors.length > 0, "the curtain must be added over the panel");
assert.ok(Math.max(...panelColors.map(([r]) => r)) > 25, "the panel must be washed towards white");
assert.ok(Math.min(...panelColors.map(([, g]) => g)) > 120, "and the panel colour must still show through");

// Where the far edge dips inside a panel, the cells it leaves are handed back the panel colour - a
// return to the terminal background there is what showed up as background coloured squares.
const panelRow = `\x1b[48;2;10;200;80m${"p".repeat(120)}`;
const dipped = Array.from({ length: PULSE_FRAMES }, (_, frame) =>
	text(120, 5, frame, { underlying: Array(5).fill(panelRow) }),
);
const dippedCells = dipped.flatMap((rows) => rows.flatMap(rowCells));
assert.ok(
	dipped.every((rows) => rows.every((row) => !row.includes("\x1b[49m"))),
	"a dipped far edge must not reset the panel background",
);
assert.ok(dippedCells.every((cell) => cell !== undefined), "every cell of a panel row must stay painted");
// The smoothed fringe washes the far cells a little, so the nearest one only has to land close to
// the panel colour - what must not happen is a return to the terminal background.
assert.ok(
	dippedCells.some(([r, g, b]) => r === 10 && g === 200 && b === 80) ||
		Math.min(...dippedCells.map(([r, g, b]) => Math.abs(r - 10) + Math.abs(g - 200) + Math.abs(b - 80))) <= 10,
	"cells the curtain leaves must keep the panel colour",
);

// A background we cannot decode (a terminal theme colour) is left completely alone.
const [opaque] = text(40, 1, 100, { underlying: ["\x1b[48;5;3mpanel\x1b[49m"] });
const opaqueBody = /\x1b\[48;5;3m([\s\S]*?)\x1b\[49m/.exec(opaque!)?.[1] ?? "";
assert.ok(opaqueBody.replace(SGR, "").includes("panel"), "the text must survive");
assert.ok(!opaqueBody.includes("48;2;"), "an undecodable panel background must not be repainted");

// A truecolor foreground is not a background, even when its components look like one.
const [coloured] = text(20, 1, 100, { underlying: ["\x1b[38;2;100;101;102mbright"] });
assert.ok(coloured!.includes("48;2;"), "foreground colours must not stop the curtain");

// xterm 256 colours can be resolved from index 16 up; the first 16 are terminal specific.
assert.deepEqual(xterm256(196), [255, 0, 0]);
assert.deepEqual(xterm256(244), [128, 128, 128]);
assert.deepEqual(xterm256(255), [238, 238, 238]);
assert.equal(xterm256(3), undefined);

// Hyperlinks survive untouched, and are not counted as columns.
const [linked] = text(20, 1, 100, { underlying: ["\x1b]8;;http://x\x1b\\link"] });
assert.ok(linked!.includes("\x1b]8;;http://x\x1b\\"), "the hyperlink must survive");
assert.ok(linked!.replace(SGR, "").endsWith("link" + " ".repeat(16)), "four link cells, sixteen curtain cells");

// Wide characters: one background per double width cell, and the column math adds up.
const wide = (value: string) => (value.codePointAt(0)! > 0x2e80 ? 2 : 1);
const [cjk] = text(6, 1, 100, { underlying: ["中中中"], measure: wide });
assert.equal(cjk!.replace(SGR, ""), "中中中", "three double width cells cover six columns exactly");
const [padded] = text(7, 1, 100, { underlying: ["中中中"], measure: wide });
assert.equal(padded!.replace(SGR, ""), "中中中 ", "the leftover column is filled with curtain");

// Rows without a source fall back to a plain wash.
const [plain] = text(12, 1, 100);
assert.equal(cells(plain!), 12);

// --- row math ---------------------------------------------------------------

// 30 rows, 5 of them below the input box's top border (editor + footer), curtain 5 tall.
assert.equal(auroraRow(30, 5, 5), 20);
assert.equal(auroraRow(30, 5, 1), 24);
assert.equal(auroraRow(30, 0, 5), 25);
assert.equal(auroraRow(10, 10, 5), undefined);
assert.equal(auroraRow(30, 5, 0), undefined);

// --- terminal background ----------------------------------------------------

// The OSC 11 reply, in the shapes terminals actually send: 16 bit channels, 8 bit channels, a hex
// triple, BEL or ST terminated.
assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:282c/2c34/343c\x07"), [40, 44, 52]);
assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:14/16/22\x07"), [20, 22, 34]);
assert.deepEqual(parseBackgroundReply("\x1b]11;rgb:0000/0000/0000\x1b\\"), [0, 0, 0]);
assert.deepEqual(parseBackgroundReply("\x1b]11;#0e1016\x07"), [14, 16, 22]);
assert.equal(parseBackgroundReply("\x1b]10;rgb:ffff/ffff/ffff\x07"), undefined, "only the background is ours");
assert.equal(parseBackgroundReply("hello"), undefined, "ordinary typing is not a colour reply");
assert.equal(parseBackgroundReply("\x1b]11;rgb:zz/00/00\x07"), undefined, "a broken reply leaves the fallback");
assert.ok(OSC11_QUERY.endsWith("11;?\x07"), "the query asks for the background, BEL terminated");

// --- overlay mouse gates ----------------------------------------------------

/** Stands in for the pi TUI: the stock gate counts every visible overlay, non-capturing included. */
const fakeTui = (...overlays: { options?: { nonCapturing?: boolean } }[]) =>
	Object.create({
		overlayStack: overlays,
		isOverlayVisible: () => true,
		hasOverlay() {
			return this.overlayStack.some((overlay) => this.isOverlayVisible(overlay));
		},
	});

const curtainOnly = fakeTui({ options: { nonCapturing: true } });
assert.equal(curtainOnly.hasOverlay(), true, "stock pi counts a non-capturing curtain as an overlay");
patchMouseGates(curtainOnly);
assert.equal(curtainOnly.hasOverlay(), false, "with only a curtain up the mouse stays with pi");
curtainOnly.overlayStack.push({ options: {} });
assert.equal(curtainOnly.hasOverlay(), true, "a capturing overlay still takes the mouse");
restoreMouseGates();
assert.equal(curtainOnly.hasOverlay(), true, "the stock gate comes back when the curtains go");
patchMouseGates({ render: () => [], invalidate: () => {} }); // no gate on the host: a no-op, not a crash
restoreMouseGates();

// --- wiring -----------------------------------------------------------------

/** Runs the extension against a fake TUI: docks, both curtains, transcript content and cleanup. */
const runWiring = async (auroraExtension: (pi: any) => void, modernQuery: boolean, curtainRows: number) => {
	const rows = 30;
	let editorLines = 3;
	let statusLines: string[] = []; // the working line, when the editor does not embed it
	let scroll = 0;
	let scrollbarMode: "hidden" | "auto" | "always" = "hidden";
	let terminalInput: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let probe: any;
	const screen: any = { overlays: [] as any[], hidden: false };
	const replies: string[] = [];
	const [top, bottom] = [() => screen.overlays[0], () => screen.overlays[1]];

	const fill = (n: () => number) => ({ render: () => Array.from({ length: n() }, () => "x"), invalidate: () => {} });
	const lines = (content: () => string[]) => ({ render: content, invalidate: () => {} });
	const document = { render: () => ["doc-1", "doc-2", "doc-3", "doc-4", "doc-5"], invalidate: () => {} };
	// Fullscreen renders the transcript through a scroller: render() returns every content line and
	// the visible window is the scroll offset plus the viewport height.
	const scroller: any = {
		render: () => Array.from({ length: 12 }, (_, i) => `c-${i + 1}`),
		viewportHeight: 8,
		get scrollTop() {
			return scroll;
		},
		getContentWidth: (width: number) => width - (scrollbarMode === "always" ? 1 : 0),
		get isScrollbarVisible() {
			return scrollbarMode !== "hidden";
		},
		invalidate: () => {},
	};
	// The widget host owns one leading spacer row plus whatever the probe renders (nothing).
	const widgetHost: any = {
		children: [] as any[],
		render: (w: number) => ["", ...(probe?.render(w) ?? [])],
		invalidate: () => {},
	};
	const tui: any = {
		mode: "regular",
		children: [document, lines(() => statusLines), widgetHost, fill(() => editorLines), fill(() => 2)],
		terminal: { rows, columns: 80 },
		showOverlay: (component: any, options: any) => {
			screen.overlays.push({ component, options });
			screen.hidden = false;
			return {
				hide: () => {
					screen.overlays = screen.overlays.filter((entry: any) => entry.component !== component);
					screen.hidden = true;
				},
			};
		},
		requestRender: () => {},
	};
	// pi 1.1 answers this one; the OSC 11 fallback is what runs when a build has neither.
	if (modernQuery) tui.queryTerminalColors = () => Promise.resolve({ background: { r: 255, g: 0, b: 0 } });

	const handlers = new Map<string, (event: any, ctx: any) => void>();
	const ctx: any = {
		mode: "tui",
		ui: {
			setWidget: (_key: string, factory: any) => {
				probe = typeof factory === "function" ? factory(tui) : undefined;
				widgetHost.children = probe ? [probe] : [];
			},
			onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
				terminalInput = handler;
				return () => (terminalInput = undefined);
			},
		},
	};
	const pi: any = { on: (name: string, handler: any) => void handlers.set(name, handler) };
	const fire = (name: string, event: any = {}) => handlers.get(name)!(event, ctx);
	const shown = () => [...top().component.render(60), ...bottom().component.render(60)].join("\n").replace(SGR, "");
	const topText = () => top().component.render(60).join("\n").replace(SGR, "");
	const glow = () => mean(colors(bottom().component.render(200)[4]!).map(([, g]) => g));

	auroraExtension(pi);
	assert.equal(screen.overlays.length, 0, "no curtain while idle");

	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk: string) => (replies.push(String(chunk)), true)) as never;
	fire("agent_start");
	process.stdout.write = write;
	assert.equal(screen.overlays.length, 2, "one curtain on the input box, one on the top row");
	assert.equal(top().options.row, 0, "the mirrored curtain sits on the first screen row");
	assert.equal(bottom().options.maxHeight, curtainRows);

	// A frame renders the dock, which renders the probe, which pins the curtains and reads what they cover.
	widgetHost.render(80);
	assert.equal(bottom().options.row, auroraRow(rows, 3 + 2, curtainRows), "curtain bottom sits on the input box");
	assert.equal(bottom().options.width, 80, "a plain transcript has no column to spare");

	// The window is taller than the content, so the top rows are blank and carry no text.
	assert.ok(!topText().trim(), "short transcripts leave the top rows blank");

	// A short window puts the frame's own rows on the first screen rows: 12 rows of content (5 doc +
	// 5 dock + 2 below) in a 9 row window start the top curtain three rows above the transcript's end.
	tui.terminal.rows = 9;
	widgetHost.render(80);
	assert.ok(topText().includes("doc-4"), "the top curtain must carry the rows that are really there");
	tui.terminal.rows = rows;
	widgetHost.render(80);

	// A working line above the editor stays where it is: the curtain lifts off the input box instead.
	statusLines = ["⠋ Working (esc to interrupt)"];
	widgetHost.render(80);
	assert.equal(bottom().options.row, auroraRow(rows, 3 + 2 + 2, curtainRows), "the curtain must not touch the working line");
	assert.ok(!shown().includes("Working"), "the working line must stay out of both curtains");
	statusLines = [];
	widgetHost.render(80);
	assert.equal(bottom().options.row, auroraRow(rows, 3 + 2, curtainRows), "without a working line it is flush again");

	// Scrolled back in fullscreen: the curtains must carry the rows on screen, never the newest text.
	tui.mode = "fullscreen";
	tui.layoutRoot = { children: [scroller] };
	// Window tall enough for the fake: 8 viewport rows + 1 spacer row + editor 3 + footer 2.
	tui.terminal.rows = 8 + 1 + 3 + 2;
	widgetHost.render(80);
	assert.ok(shown().includes("c-1") && shown().includes("c-8"), "both curtains follow the scrolled viewport");
	assert.ok(!shown().includes("c-12"), "live text must not be painted over the older messages");

	// A visible scrollbar keeps its column: the curtains stop one column short of it.
	scrollbarMode = "auto";
	widgetHost.render(80);
	assert.equal(bottom().options.width, 79, "the curtain must not cover the scrollbar column");
	assert.equal(cells(bottom().component.render(79)[0]!), 79, "and it renders exactly that many cells");
	scrollbarMode = "always";
	widgetHost.render(80);
	assert.equal(bottom().options.width, 79, "a reserved scrollbar column is left alone too");
	scrollbarMode = "hidden";
	widgetHost.render(80);
	assert.equal(bottom().options.width, 80, "without a scrollbar the curtain spans the whole width");
	scroll = 4;
	widgetHost.render(80);
	assert.ok(shown().includes("c-12"), "scrolled back to the end, the newest rows are covered again");
	tui.mode = "regular";
	tui.layoutRoot = undefined;
	tui.terminal.rows = rows;

	// What the terminal answers is what the curtain fades into. The reply is read off the raw input
	// stream (swallowed, not typed into the editor) when the running pi has no query API at all.
	widgetHost.render(80);
	const fallback = mean(colors(bottom().component.render(200)[4]!).map(([r]) => r));
	if (modernQuery) {
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(terminalInput, undefined, "a pi that can answer the query is asked instead");
		assert.ok(!replies.some((chunk) => chunk.includes("\x1b]11;?")), "and the raw stdin is left alone");
	} else {
		assert.ok(replies.some((chunk) => chunk.includes("\x1b]11;?")), "the extension must ask the terminal itself");
		assert.equal(terminalInput!("\x1b]11;rgb:ff/00/00\x07")?.consume, true, "the reply must be swallowed");
		assert.equal(terminalInput, undefined, "the listener unsubscribes once the colour is known");
	}
	assert.ok(
		mean(colors(bottom().component.render(200)[4]!).map(([r]) => r)) > fallback + 50,
		"the curtain must fade into the colour the terminal reported",
	);

	// The run ended: the curtains dissolve over the next frames instead of vanishing at once.
	const before = glow();
	fire("agent_settled");
	assert.equal(screen.overlays.length, 2, "agent_settled must not hide the curtains at once");
	for (let i = 0; i < 3; i++) widgetHost.render(80);
	assert.ok(glow() < before * 0.75, "the curtains must dim while dissolving");
	for (let i = 0; i < 4; i++) widgetHost.render(80);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(screen.overlays.length, 0, "after the fade the curtains are gone");
	assert.equal(probe, undefined, "after the fade the probe is removed");
};

void import("./index.ts").then(
	async ({ default: auroraExtension, ROWS }) => {
		assert.equal(typeof ROWS, "number", "the extension must publish its curtain height");
		await runWiring(auroraExtension, true, ROWS);
		await runWiring(auroraExtension, false, ROWS);
	},
	() =>
		console.log(
			"aurora-line: rendering checks passed (wiring check needs pi's jiti loader: run this file with pi)",
		),
);
