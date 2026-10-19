/**
 * Aurora Line - while the agent streams, two mirrored curtains of white/grey aurora breathe over the
 * window: both hung off the edge nearest the input box, one mirrored on the very first screen row.
 * The curtains tint the rows they cover instead of erasing them, so the output underneath stays
 * readable. Thinking streams the same curtain, dimmed. When the run ends the curtains dissolve.
 *
 * Install: keep this folder in ~/.pi/agent/extensions/ (loaded automatically), or run
 *   pi --extension ~/.pi/agent/extensions/aurora-line
 *
 * While a curtain is up, the live TUI prototype's mouse gate is patched (see aurora.ts) so the
 * overlays stay transparent to scrollbar dragging and drag-selection. Nothing on disk is changed.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Component, Container, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import {
	auroraRow,
	auroraRows,
	FALLBACK_BG,
	OSC11_QUERY,
	parseBackgroundReply,
	patchMouseGates,
	restoreMouseGates,
	type AuroraMode,
	type Rgb,
} from "./aurora.ts";

const WIDGET_KEY = "aurora-line";
const FRAME_MS = 90;

/** The colours pi answers a terminal query with, in the shapes 1.1 and 0.85 return them. */
type RgbLike = { r: number; g: number; b: number };
type TerminalColorReport = { background?: RgbLike };
/** Curtain height; the bottom curtain's last row covers the dock row right above the input box. */
export const ROWS = 5;
/** Frames the curtain takes to dissolve once the run has ended. */
const FADE_FRAMES = 7;

/**
 * The rows a transcript source is actually showing. A ScrollView renders its whole content, so the
 * scrolled-back part has to be skipped with its own scroll offset - otherwise the curtain would paint
 * live text on top of the older messages the user scrolled to. The document body (regular mode) is
 * shown tail-first by the terminal and needs no slicing.
 */
const visibleRows = (source: Component, width: number): string[] => {
	const rendered = source.render(width);
	const view = source as Component & { scrollTop?: number; viewportHeight?: number };
	if (typeof view.scrollTop !== "number" || typeof view.viewportHeight !== "number") return rendered;
	const from = Math.max(0, view.scrollTop);
	const window = rendered.slice(from, from + Math.max(0, view.viewportHeight));
	while (window.length < view.viewportHeight) window.push(""); // short transcript: blank rows at the bottom
	return window;
};

/** Terminal image markers must never be copied into a text curtain. */
const plain = (lines: string[]): string[] =>
	lines.map((line) => (line.startsWith("\x1b_G") || line.startsWith("\x1b]1337;File=") ? "" : line));

/** The last `count` rows of two stacked parts, without copying the whole transcript around. */
const tail = (head: string[], end: string[], count: number): string[] =>
	end.length >= count ? end.slice(-count) : [...head.slice(-(count - end.length)), ...end];

export default function (pi: ExtensionAPI) {
	let tui: TUI | undefined;
	let context: ExtensionContext | undefined;
	let handleTop: OverlayHandle | undefined;
	let handleBottom: OverlayHandle | undefined;
	let optsTop: OverlayOptions | undefined;
	let optsBottom: OverlayOptions | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let frame = 0;
	let mode: AuroraMode = "text";
	let active = false;
	let fading = false;
	let opacity = 1;
	let measuring = false;
	let askedForBg = false;
	let bg: Rgb = FALLBACK_BG;
	let coveredTop: string[] = [];
	let coveredBottom: string[] = [];
	/** Columns the curtains may paint; the scrollbar column is left to pi. */
	let coverWidth = 0;

	// Sits in the dock above the editor and renders nothing, so it never changes the layout:
	// it only hands us a live TUI handle and one per-frame hook.
	const probe: Component = {
		render: (width) => {
			if ((active || fading) && !measuring) scan(width);
			return [];
		},
		invalidate: () => {},
	};

	const curtain = (flip: boolean): Component => ({
		render: (width) =>
			auroraRows({
				width,
				rows: ROWS,
				frame,
				mode,
				bg,
				underlying: flip ? coveredTop : coveredBottom,
				measure: visibleWidth,
				flip,
				opacity,
			}),
		invalidate: () => {},
	});
	const topCurtain = curtain(true);
	const bottomCurtain = curtain(false);

	/**
	 * Per-frame pass: place the bottom curtain flush on top of the input box, mirror the top one on
	 * the first screen row, grab the lines both will cover, and dissolve the pair once the run ended.
	 */
	const scan = (width: number) => {
		if (!tui || !optsBottom) return;
		const roots = tui.children;
		const host = roots.findIndex((root) => (root as Container).children?.includes(probe));
		if (host < 0) return;
		measuring = true;
		const transcript: string[] = [];
		const dock: string[] = [];
		let below = 0;
		try {
			// Fullscreen draws the transcript through a scroller, which is the only way to see what
			// is really on screen when the transcript is scrolled back; regular mode draws the
			// transcript body itself (the terminal keeps its tail on screen).
			const layout = (tui as unknown as { layoutRoot?: Container }).layoutRoot;
			const scroller = layout?.children?.[0] ?? (tui.mode === "regular" ? roots[0] : undefined);
			if (scroller) {
				transcript.push(...visibleRows(scroller, width));
				// The scrollbar sits in the last column: a scroller that reserves it (`always`) renders its
				// content one column narrower, one that draws it on top (`auto`) does not. Painting that
				// column would erase the scrollbar, so the curtain stops short of it while it is shown.
				const view = scroller as {
					getContentWidth?: (width: number) => number;
					isScrollbarVisible?: boolean;
				};
				const content = typeof view.getContentWidth === "function" ? view.getContentWidth.call(scroller, width) : width;
				coverWidth = content < width || view.isScrollbarVisible ? Math.max(1, width - 1) : width;
			} else {
				coverWidth = width;
			}
			for (let i = 1; i < roots.length; i++) {
				const rendered = roots[i]!.render(width);
				if (i <= host) dock.push(...rendered);
				else below += rendered.length;
			}
		} finally {
			measuring = false;
		}
		// Bottom curtain: never paint over a dock row that carries text (the working line, queued
		// messages, other extensions' widgets), only the blank padding above the input box.
		const content = dock.findIndex((line) => visibleWidth(line) > 0);
		const padding = content < 0 ? dock.length : content;
		const row = auroraRow(tui.terminal.rows, below + dock.length - padding, ROWS);
		if (row !== undefined) optsBottom.row = row;
		optsTop.width = coverWidth;
		optsBottom.width = coverWidth;
		coveredBottom = plain(tail(transcript, dock.slice(0, padding), ROWS));

		// Top curtain: the frame starts at `frameLength - terminalRows`, which is above the frame
		// (blank screen rows) while the transcript is still shorter than the window.
		const offset = transcript.length + dock.length + below - tui.terminal.rows;
		const top: string[] = [];
		for (let i = 0; i < ROWS; i++) {
			const index = offset + i;
			top.push(
				index >= 0 && index < transcript.length
					? transcript[index]!
					: index >= transcript.length && index - transcript.length < dock.length
						? dock[index - transcript.length]!
						: "",
			);
		}
		coveredTop = plain(top);

		if (!fading) return;
		opacity = Math.max(0, opacity - 1 / FADE_FRAMES);
		// Hiding the overlays and the widget touches the component tree, so do it outside this render.
		if (opacity <= 0.001) {
			opacity = 0;
			queueMicrotask(() => (fading && context ? finish(context) : undefined));
		}
	};

	/**
	 * The curtain is a wash over the terminal background, so it needs that colour. pi 1.1 answers it
	 * through `queryTerminalColors`, 0.85 through `queryTerminalBackgroundColor`; a build with neither
	 * gets the OSC 11 query sent here, with the reply picked out of the raw input stream (and
	 * swallowed, so it never reaches the editor). A terminal that stays quiet keeps the fallback.
	 */
	const askBackground = (ctx: ExtensionContext, tui: TUI) => {
		if (askedForBg) return;
		askedForBg = true;
		let listening = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let off: (() => void) | undefined;
		const settle = (color: Rgb | undefined) => {
			if (!listening) return;
			listening = false;
			clearTimeout(timer);
			off?.();
			if (color) bg = color;
		};
		const rgb = (color: RgbLike | undefined): Rgb | undefined => (color ? [color.r, color.g, color.b] : undefined);

		const colors = (tui as Partial<{ queryTerminalColors: (options: object) => Promise<TerminalColorReport> }>)
			.queryTerminalColors;
		if (typeof colors === "function") {
			void colors
				.call(tui, { timeoutMs: 400, onLateReply: (late: TerminalColorReport) => settle(rgb(late.background)) })
				.then((report) => settle(rgb(report?.background)))
				.catch(() => settle(undefined));
			return;
		}
		const legacy = (
			tui as { queryTerminalBackgroundColor?: (options: { timeoutMs: number }) => Promise<Rgb | undefined> }
		).queryTerminalBackgroundColor;
		if (typeof legacy === "function") {
			void legacy
				.call(tui, { timeoutMs: 250 })
				.then((color) => settle(color ? [color.r, color.g, color.b] : undefined))
				.catch(() => settle(undefined));
			return;
		}
		if (typeof ctx.ui.onTerminalInput !== "function") return;
		timer = setTimeout(() => settle(undefined), 500);
		off = ctx.ui.onTerminalInput((data) => {
			const color = parseBackgroundReply(data);
			if (!color) return undefined;
			settle(color);
			return { consume: true };
		});
		process.stdout.write(OSC11_QUERY);
	};

	/** The run is over: keep the curtains up and let the next frames dissolve them. */
	const fadeOut = () => {
		if (active) fading = true;
	};

	const mountProbe = (ctx: ExtensionContext) => {
		ctx.ui.setWidget(WIDGET_KEY, (t) => {
			tui = t;
			askBackground(ctx, t);
			return probe;
		});
	};

	const start = (ctx: ExtensionContext) => {
		context = ctx;
		mountProbe(ctx); // refresh the handle: it goes stale when the TUI mode is switched
		if (active) return;
		active = true;
		frame = 0;
		mode = "text";
		if (fading) {
			// A new run arrived while the old curtains were still dissolving: bring them back rather
			// than stacking a second pair of overlays.
			fading = false;
			opacity = 1;
			return;
		}
		if (!tui) {
			active = false;
			return;
		}
		patchMouseGates(tui);
		optsTop = { row: 0, col: 0, width: "100%", maxHeight: ROWS, nonCapturing: true };
		optsBottom = { row: 0, col: 0, width: "100%", maxHeight: ROWS, nonCapturing: true };
		coverWidth = tui.terminal.columns;
		handleTop = tui.showOverlay(topCurtain, optsTop);
		handleBottom = tui.showOverlay(bottomCurtain, optsBottom);
		timer = setInterval(() => {
			frame++;
			tui?.requestRender();
		}, FRAME_MS);
	};

	const finish = (ctx: ExtensionContext) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		active = false;
		fading = false;
		opacity = 1;
		coveredTop = [];
		coveredBottom = [];
		restoreMouseGates();
		handleTop?.hide();
		handleBottom?.hide();
		handleTop = undefined;
		handleBottom = undefined;
		optsTop = undefined;
		optsBottom = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode === "tui") start(ctx);
	});

	pi.on("message_update", (event) => {
		if (active || fading) mode = event.assistantMessageEvent.type.startsWith("thinking") ? "think" : "text";
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode === "tui") fadeOut();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui" && (active || fading)) finish(ctx);
		restoreMouseGates();
		tui = undefined;
	});
}
