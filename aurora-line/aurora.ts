/**
 * Pure monochrome curtain rendering plus the tint compositor that keeps the text underneath
 * readable. Free of pi imports so `node check.ts` can exercise it.
 */

export type AuroraMode = "text" | "think";
export type Rgb = [number, number, number];

/** Breathing period in frames; one frame per FRAME_MS in the extension (~5s at 90ms). */
export const PULSE_FRAMES = 56;
/** Bright white at the core edge, dim grey at the far end: no colour anywhere. */
const CORE: Rgb = [236, 236, 236];
const HAZE: Rgb = [150, 150, 150];
/** How much the thinking curtain is dimmed. */
const THINK_DIM = 0.75;
/** Alpha ceiling: the curtain is a wash behind the transcript, so the text on top stays readable. */
const ALPHA_CAP = 0.55;
/**
 * One flat sheet: every row the curtain reaches gets the same wash, so there are no steps between
 * rows. The band's shape comes from how far it reaches per column, not from a ramp, which is what
 * used to read as separate layers.
 */
const SHEET_ALPHA = 0.62;
/** Background the curtain fades into when the terminal does not answer the OSC 11 query. */
export const FALLBACK_BG: Rgb = [14, 16, 22];

const RESET = "\x1b[0m";
const DEFAULT_BACKGROUND = "\x1b[49m";
const ESCAPE = "\x1b";

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** Smoothstep: starts and ends on a zero slope, so the fade it shapes shows no line where it stops. */
const ease = (t: number) => t * t * (3 - 2 * t);

/** Options for one curtain: a batch of rows plus what it tints. */
export interface CurtainOptions {
	width: number;
	rows: number;
	frame: number;
	mode: AuroraMode;
	/** Terminal background the curtain fades into. */
	bg?: Rgb;
	/** The rendered lines this curtain covers, redrawn on top so their text stays readable. */
	underlying?: readonly string[];
	/** Cell width measure (pi's `visibleWidth`); defaults to code points. */
	measure?: (text: string) => number;
	/** Rows grow away from this edge instead of the other way (curtain above the input box). */
	flip?: boolean;
	/** Global scale from 1 to 0, used to dissolve the curtain when the run ends. */
	opacity?: number;
}

/** One cell of curtain: the colour it adds and how strongly. */
interface Wash {
	shade: Rgb;
	alpha: number;
}

/**
 * One intensity per column: thin vertical rays that travel sideways, so the curtain visibly moves.
 * The terms drift at different speeds, which shears the rays instead of sliding a still image.
 * The harmonics stay long (periods of 15 columns and up): a faster one only puts hard vertical edges
 * between neighbouring cells, which the eye reads as a grid of squares.
 */
function rays(x: number, frame: number): number {
	const shift = frame * 0.4;
	const t = frame / 26;
	const n =
		Math.sin((x + shift) * 0.19 + t * 0.6) * 0.42 +
		Math.sin((x + shift * 1.6) * 0.27 - t * 0.4) * 0.3 +
		Math.sin((x + shift * 0.7) * 0.41 + t * 0.3) * 0.18 +
		Math.sin((x + shift * 0.3) * 0.061 + t * 0.15) * 0.1;
	return clamp01(0.5 + 0.75 * n) ** 1.4;
}

/** A slow bright wave running along the curtain, so it also surges sideways. */
const wave = (x: number, frame: number) => 0.82 + 0.18 * Math.sin(x * 0.017 - frame / 24);

/**
 * How far the curtain reaches from its core edge at this column, in rows. Three slow harmonics give
 * it its shape and two fine ones give it texture, so the far edge is a frayed line rather than a
 * smooth wave. The floor keeps the core plus one row everywhere: the curtain never breaks apart.
 */
function curtainHeight(x: number, rows: number, frame: number): number {
	const t = frame / 45;
	const n =
		Math.sin(x * 0.019 + t * 0.4) * 0.5 +
		Math.sin(x * 0.052 - t * 0.27) * 0.24 +
		Math.sin(x * 0.0071 + t * 0.11) * 0.12 +
		Math.sin(x * 0.12 + t * 0.8) * 0.09 +
		Math.sin(x * 0.17 - t * 1.1) * 0.05;
	return rows * Math.min(1, Math.max(0.4, 0.55 + 0.7 * n));
}

/**
 * How strongly the curtain reaches one cell before the band is smoothed. Flat across the band: only
 * how far it reaches per column and the breathing/ray modulation change from cell to cell.
 */
function cellAlpha(x: number, y: number, curtain: CurtainOptions): number {
	const { rows, frame, mode } = curtain;
	const distance = curtain.flip ? y : rows - 1 - y; // rows away from the core edge
	const reach = curtainHeight(x, rows, frame);
	// Fractional coverage, eased: the row the far edge cuts through fades away instead of switching
	// off, and the eased ends mean the fade starts and stops without a visible line.
	// The fade runs over two rows, not one: with only a fractional row to land on, the wash stopped
	// on a line instead of trailing off.
	const coverage = ease(clamp01((reach - distance) / 2));
	if (coverage <= 0) return 0;
	const v = curtain.flip ? (rows - y) / rows : (y + 1) / rows;
	// The band's outermost rows are a window edge, not a curtain edge: the wash lands over the top row
	// and a half, so it never meets the untinted transcript above on a line. Never more than half the
	// band, or a band of one or two rows would land on nothing at all.
	const landingSpan = Math.min(1.5, (rows - 1) / 2);
	const landing = landingSpan <= 0 ? 1 : ease(clamp01((rows - 1 - distance) / landingSpan));
	const breath = 0.88 + 0.12 * (0.5 - 0.5 * Math.cos((frame / PULSE_FRAMES) * Math.PI * 2)); // 0.88 .. 1.0
	const filament = rays(x, frame);
	const rayMix = 0.28 + 0.72 * (1 - v); // the core edge is a nearly unbroken line, the haze breaks into rays
	return (
		ALPHA_CAP *
		SHEET_ALPHA *
		landing *
		coverage *
		(1 - rayMix * (1 - filament)) *
		breath *
		wave(x, frame) *
		(0.85 + 0.15 * Math.min(1, reach / rows)) * // tall columns glow a little brighter
		clamp01(curtain.opacity ?? 1) *
		(mode === "think" ? THINK_DIM : 1)
	);
}

/** Alpha-composite `color` over `background`. */
function mix(background: Rgb, color: Rgb, alpha: number): Rgb {
	const a = clamp01(alpha);
	return [0, 1, 2].map((i) => Math.round(background[i]! + (color[i]! - background[i]!) * a)) as Rgb;
}

/** The grey of the sheet: halfway between the haze and the core. */
const SHEET_SHADE: Rgb = mix(HAZE, CORE, 0.5);

/** xterm 256 palette entry to RGB. Indices 0-15 are whatever the terminal's theme says, so unknown. */
export function xterm256(index: number): Rgb | undefined {
	if (!Number.isInteger(index) || index < 16 || index > 255) return undefined;
	if (index < 232) {
		const cube = index - 16;
		const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
		return [level(Math.floor(cube / 36)), level(Math.floor((cube % 36) / 6)), level(cube % 6)];
	}
	const grey = 8 + (index - 232) * 10;
	return [grey, grey, grey];
}

const background = (color: Rgb) => `${ESCAPE}[48;2;${color[0]};${color[1]};${color[2]}m`;

/** Alpha below which a cell is left exactly as pi drew it. */
const MIN_ALPHA = 0.002;

/**
 * The curtain's intensity over the whole band, smoothed. A terminal has no sub-cell gradients, so
 * neighbouring cells have to land on close colours: the blur is what turns the raw per-cell wash
 * into a continuous sheet instead of a grid of squares and a bright band per row.
 */
function washField(curtain: CurtainOptions): Float32Array {
	const { width, rows } = curtain;
	const field = new Float32Array(width * rows);
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < width; x++) field[y * width + x] = cellAlpha(x, y, curtain);
	}
	// Sideways the wash needs three passes to lose the cell grid; down the band four, because the fade
	// at the far edge has to span the two rows it is given rather than land on one line.
	for (const vertical of [false, true]) {
		const passes = vertical ? 4 : 3;
		for (let pass = 0; pass < passes; pass++) blur(field, width, rows, vertical);
	}
	return field;
}

/** One [1,2,1] pass over the grid, along a row (`vertical` false) or down the band. */
function blur(field: Float32Array, width: number, rows: number, vertical: boolean) {
	const copy = Float32Array.from(field);
	const edge = (index: number, end: number) => Math.max(0, Math.min(end - 1, index));
	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < width; x++) {
			const here = copy[y * width + x]!;
			const before = vertical ? copy[edge(y - 1, rows) * width + x]! : copy[y * width + edge(x - 1, width)]!;
			const after = vertical ? copy[edge(y + 1, rows) * width + x]! : copy[y * width + edge(x + 1, width)]!;
			field[y * width + x] = (before + 2 * here + after) / 4;
		}
	}
}

/**
 * One curtain: `rows` lines, hung from the edge nearest the input box - the first row of the batch
 * when `flip` is set (the band at the top of the window), the last one otherwise. `underlying[y]` is
 * the rendered line that row covers: it is drawn again on top of the curtain, so the aurora tints the
 * transcript instead of erasing it. Cells the curtain does not reach, and rows without a source, are
 * left as they are.
 */
export function auroraRows(curtain: CurtainOptions): string[] {
	const { width, rows, underlying = [], measure = (text: string) => [...text].length } = curtain;
	if (width <= 0 || rows <= 0) return [];
	const terminal = curtain.bg ?? FALLBACK_BG;
	const field = washField(curtain);
	const lines: string[] = [];
	for (let y = 0; y < rows; y++) {
		const washAt = (x: number): Wash | undefined => {
			const alpha = field[y * width + x]!;
			// One smooth grey everywhere: no hue is ever mixed, the curtain is white to grey only.
			return alpha < MIN_ALPHA ? undefined : { shade: SHEET_SHADE, alpha };
		};
		const source = underlying[y];
		lines.push(source === undefined ? wash(width, washAt, terminal) : tint(source, width, washAt, measure, terminal));
	}
	return lines;
}

/** A row of pure curtain, used where nothing is underneath. */
function wash(width: number, washAt: (x: number) => Wash | undefined, terminal: Rgb): string {
	let out = "";
	let painted: string | undefined;
	for (let x = 0; x < width; x++) {
		const cell = washAt(x);
		if (cell === undefined) {
			// Outside the curtain: hand the cell back to whatever background was there before.
			if (painted !== undefined) {
				out += DEFAULT_BACKGROUND;
				painted = undefined;
			}
		} else {
			const sgr = background(mix(terminal, cell.shade, cell.alpha));
			if (sgr !== painted) {
				out += sgr;
				painted = sgr;
			}
		}
		out += " ";
	}
	return out + RESET;
}
/**
 * The same row, but carrying the text it covers: the curtain only repaints the background, so the
 * characters (and their own colours) stay exactly where pi drew them.
 *
 * Text that already has a background of its own - tool panels, code blocks - keeps that colour as
 * the base, so the curtain is *added* on top of it instead of hiding it, and cells the curtain does
 * not reach are handed back that same colour. Only backgrounds we cannot decode (the terminal's own
 * 16 theme colours) are left untouched.
 */
function tint(
	line: string,
	width: number,
	washAt: (x: number) => Wash | undefined,
	measure: (text: string) => number,
	terminal: Rgb,
): string {
	let out = "";
	let col = 0;
	let painted: string | undefined;
	let base: BaseBackground = { has: false, color: undefined };
	/** The background the covered line carries where the curtain does not reach. */
	const restore = (): string => (base.has ? background(base.color ?? terminal) : DEFAULT_BACKGROUND);
	let i = 0;
	while (i < line.length && col < width) {
		if (line[i] === ESCAPE) {
			const end = escapeEnd(line, i);
			const sequence = line.slice(i, end);
			out += sequence;
			if (touchesBackground(sequence)) {
				painted = undefined;
				base = baseBackground(sequence, base);
			}
			i = end;
			continue;
		}
		const char = String.fromCodePoint(line.codePointAt(i)!);
		const cell = washAt(col);
		if (cell === undefined) {
			// Outside the curtain: hand the cell back the background the line had here - the terminal's
			// own only when the line brought none. Emitting the terminal default instead cuts a
			// background coloured notch into a tool panel wherever the far edge dips.
			if (painted !== undefined) {
				out += restore();
				painted = undefined;
			}
		} else if (!base.has || base.color !== undefined) {
			const sgr = background(mix(base.color ?? terminal, cell.shade, cell.alpha));
			if (sgr !== painted) {
				out += sgr;
				painted = sgr;
			}
		} else {
			painted = undefined; // a background we cannot decode: leave the cell alone
		}
		out += char;
		col += measure(char);
		i += char.length;
	}
	if (col < width) {
		// Trailing cells: the curtain, blended onto whatever background is still active - or, when that
		// background cannot be decoded, left exactly as it is.
		for (let x = col; x < width; x++) {
			const cell = washAt(x);
			if (cell !== undefined && (!base.has || base.color !== undefined)) {
				const sgr = background(mix(base.color ?? terminal, cell.shade, cell.alpha));
				if (sgr !== painted) {
					out += sgr;
					painted = sgr;
				}
			} else if (painted !== undefined) {
				out += restore();
				painted = undefined;
			}
			out += " ";
		}
	}
	return out + RESET;
}

/** The background the covered line carries where the curtain does not reach. */
const restore = (base: BaseBackground): string => (base.has ? background(base.color ?? FALLBACK_BG) : DEFAULT_BACKGROUND);

/** End index (exclusive) of the escape sequence starting at `start`. */
function escapeEnd(line: string, start: number): number {
	const kind = line[start + 1];
	if (kind === "[") {
		let i = start + 2;
		while (i < line.length && !(line[i]! >= "@" && line[i]! <= "~")) i++;
		return Math.min(line.length, i + 1);
	}
	if (kind === "]") {
		let i = start + 2;
		while (i < line.length) {
			if (line[i] === "\u0007") return i + 1;
			if (line[i] === ESCAPE && line[i + 1] === "\\") return i + 2;
			i++;
		}
		return line.length;
	}
	return Math.min(line.length, start + 2);
}

/** True when an SGR sequence sets or clears the background. */
function touchesBackground(sequence: string): boolean {
	if (sequence[1] !== "[" || !sequence.endsWith("m")) return false;
	return sequence
		.slice(2, -1)
		.split(";")
		.some((param) => {
			const code = Number(param === "" ? 0 : param);
			return code === 0 || code === 49 || code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107);
		});
}

/** Background of the text being covered: whether it has one, and its colour when decodable. */
interface BaseBackground {
	has: boolean;
	color: Rgb | undefined;
}

/**
 * Background state after an SGR sequence. Colour payloads (`38;2;r;g;b`, `48;5;n`, `38;5;n`) are
 * skipped, so a foreground colour whose components happen to look like background codes is not
 * mistaken for one - and a panel's own background colour is picked up to blend the curtain onto it.
 */
function baseBackground(sequence: string, current: BaseBackground): BaseBackground {
	if (sequence[1] !== "[" || !sequence.endsWith("m")) return current;
	const params = sequence
		.slice(2, -1)
		.split(";")
		.map((param) => (param === "" ? 0 : Number(param)));
	let state = current;
	for (let i = 0; i < params.length; i++) {
		const code = params[i]!;
		const mode = params[i + 1];
		if (code === 38 || code === 48) {
			const values = [params[i + 2], params[i + 3], params[i + 4]];
			const color: Rgb | undefined =
				mode === 2 && values.every((value) => Number.isFinite(value))
					? (values as Rgb)
					: mode === 5 && Number.isFinite(params[i + 2])
						? xterm256(params[i + 2]!)
						: undefined;
			if (code === 48) state = { has: true, color };
			i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			continue;
		}
		if (code === 0 || code === 49) state = { has: false, color: undefined };
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state = { has: true, color: undefined };
	}
	return state;
}

/**
 * Top screen row of a `rows` tall band whose bottom row sits directly above the input box:
 * `below` is the number of rows between the top border of the box and the bottom of the screen.
 * Undefined when the band would not fit, so the caller keeps the previous row.
 */
export function auroraRow(terminalRows: number, below: number, rows: number): number | undefined {
	if (below < 0 || rows <= 0) return undefined;
	const row = terminalRows - below - rows;
	return row >= 0 && row + rows <= terminalRows ? row : undefined;
}

// --- terminal background ----------------------------------------------------

/** OSC 11 query: "XTerm, what is your default background colour?". */
export const OSC11_QUERY = "\x1b]11;?\x07";

const OSC11_REPLY = /^\x1b\]11;([^\x07\x1b]*)(?:\x07|\x1b\\)$/i;

/** One channel of an OSC colour value: hex digits, scaled from whatever depth was sent to 0..255. */
function oscChannel(channel: string): number | undefined {
	if (!/^[0-9a-f]+$/i.test(channel)) return undefined;
	const max = 16 ** channel.length - 1;
	return max > 0 ? Math.round((parseInt(channel, 16) / max) * 255) : undefined;
}

/**
 * The terminal background from an OSC 11 reply, or undefined for any other input. Terminals answer as
 * `rgb:1e1e/1e1e/1e1e` (one to four hex digits per channel) or `#rrggbb`, terminated by BEL or ST.
 */
export function parseBackgroundReply(data: string): Rgb | undefined {
	const match = data.match(OSC11_REPLY);
	if (!match) return undefined;
	const value = match[1]!
		.trim()
		.replace(/^rgba?:/i, "")
		.replace(/^#/, "");
	if (/^[0-9a-f]{6}$/i.test(value)) return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16)) as Rgb;
	const channels = value.split("/");
	if (channels.length !== 3) return undefined;
	const [r, g, b] = channels.map(oscChannel);
	return r !== undefined && g !== undefined && b !== undefined ? [r, g, b] : undefined;
}

// --- pi compatibility -------------------------------------------------------

/**
 * pi's mouse gates ask `hasOverlay()`, which counts non-capturing overlays too. While a curtain is
 * up that kills scrollbar dragging and anchors drag-selection to screen rows instead of the content.
 * Patching the live prototype restores the meaning the gates want - "an overlay that owns input" -
 * and leaves no file behind, so removing this extension removes the patch.
 */
type OverlayHost = {
	overlayStack?: { options?: { nonCapturing?: boolean } }[];
	isOverlayVisible?: (overlay: unknown) => boolean;
	hasOverlay?: () => boolean;
};

let gated: OverlayHost | undefined;
let stockHasOverlay: (() => boolean) | undefined;

export function patchMouseGates(tui: unknown) {
	if (stockHasOverlay) return;
	let proto = Object.getPrototypeOf(tui) as OverlayHost | null;
	while (proto && !Object.prototype.hasOwnProperty.call(proto, "hasOverlay")) {
		proto = Object.getPrototypeOf(proto) as OverlayHost | null;
	}
	const stock = proto?.hasOverlay;
	if (!proto || typeof stock !== "function") return; // nothing to patch: the host keeps its own gate
	proto.hasOverlay = function (this: OverlayHost) {
		const visible = this.isOverlayVisible;
		if (!Array.isArray(this.overlayStack) || typeof visible !== "function") return stock.call(this);
		return this.overlayStack.some((overlay) => !overlay.options?.nonCapturing && visible.call(this, overlay));
	};
	gated = proto;
	stockHasOverlay = stock;
}

export function restoreMouseGates() {
	if (gated && stockHasOverlay) gated.hasOverlay = stockHasOverlay;
	gated = undefined;
	stockHasOverlay = undefined;
}
