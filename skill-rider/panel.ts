/**
 * The /skill-rider panel: a searchable skill list on the left, the original
 * SKILL.md text plus the editable extra prompt on the right, shown as a
 * centered overlay. Each pane has its own frame inside the shared outer frame.
 *
 * Keys: typing filters the list, up/down previews a skill, PageUp/PageDown
 * scroll the skill text, Tab or Enter edits the extra prompt, Enter finishes
 * editing, Shift+Enter adds a line, Esc saves and closes.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type Focusable,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface PanelSkill {
	name: string;
}

export interface PanelOptions {
	skills: PanelSkill[];
	riders: Record<string, string>;
	/** The skill's own file body, shown read-only for reference. */
	skillBody: (name: string) => string | undefined;
	/** Persist a rider; empty text removes it. */
	save: (name: string, text: string) => void;
	/** Close the panel. */
	done: () => void;
}

const LEFT_WIDTH = 28;
/** Body rows each pane keeps, so the panel does not resize as the rider changes. */
const MIN_BODY_ROWS = 16;
/** Rows the skill text keeps even when the extra prompt is long. */
const REFERENCE_MIN_ROWS = 3;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export class RiderPanel implements Focusable {
	focused = true;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly riders: Record<string, string>;
	private readonly skillBody: (name: string) => string | undefined;
	private readonly save: (name: string, text: string) => void;
	private readonly finish: () => void;
	private readonly search: Input;
	private readonly editor: Editor;
	private matches: PanelSkill[];
	private readonly skills: PanelSkill[];
	/** Index into `matches`; the list always highlights one row. */
	private selected = 0;
	private focus: "list" | "editor" = "list";
	private status = "";
	/** The highlighted skill's SKILL.md body, read when the highlight moves. */
	private reference = "";
	private referenceOffset = 0;
	private referenceVisible = REFERENCE_MIN_ROWS;
	private wrapped: string[] = [];
	private wrappedFor = "";
	private wrappedWidth = -1;

	constructor(tui: TUI, theme: Theme, options: PanelOptions) {
		this.tui = tui;
		this.theme = theme;
		this.riders = options.riders;
		this.skillBody = options.skillBody;
		this.save = options.save;
		this.finish = options.done;
		this.skills = options.skills;
		this.matches = options.skills;

		this.search = new Input({
			prompt: theme.fg("accent", "/ "),
			placeholder: "type to filter",
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		this.search.focused = true;

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("border", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		this.editor = new Editor(tui, editorTheme);
		this.editor.onChange = () => this.refresh();
		this.sync();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.commit();
			this.finish();
			return;
		}
		this.status = "";

		if (this.focus === "list") {
			// Page keys read the skill text; the editor keeps them while editing.
			if (matchesKey(data, Key.pageUp)) this.scrollReference(-(this.referenceVisible - 1));
			else if (matchesKey(data, Key.pageDown)) this.scrollReference(this.referenceVisible - 1);
			else if (matchesKey(data, Key.up)) this.move(-1);
			else if (matchesKey(data, Key.down)) this.move(1);
			else if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) this.edit();
			else {
				this.search.handleInput(data);
				this.refilter();
			}
			return;
		}

		// Editing: plain Enter leaves the editor, Shift+Enter reaches the editor as a newline.
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.commit();
			this.focus = "list";
			this.editor.focused = false;
			this.search.focused = true;
			this.refresh();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.commit();
			this.refresh();
			return;
		}
		this.editor.handleInput(data);
		this.refresh();
	}

	invalidate(): void {
		this.search.invalidate();
		this.editor.invalidate();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(30, width) - 2;
		const leftWidth = Math.min(LEFT_WIDTH, Math.max(16, Math.floor(inner / 3)));
		const rightWidth = Math.max(16, inner - leftWidth);

		const right = this.renderRightPane(rightWidth);
		const left = this.renderLeftPane(leftWidth, right.length);

		const lines: string[] = [this.panelBorder("╭", inner, " Skill Rider ")];
		for (let i = 0; i < right.length; i++) {
			lines.push(theme.fg("border", "│") + left[i]! + right[i]! + theme.fg("border", "│"));
		}
		lines.push(this.panelBorder("╰", inner, ""));
		return lines;
	}

	/** Left pane: the search box and the filtered skill list, wrapped in their own frame. */
	private renderLeftPane(width: number, rows: number): string[] {
		const theme = this.theme;
		const body: string[] = [pad(truncateToWidth(this.search.render(width - 2)[0] ?? "", width - 2, ""), width - 2)];

		if (this.matches.length === 0) {
			body.push(theme.fg("warning", " no match"));
		} else {
			const itemRows = Math.max(1, rows - 4);
			const maxOffset = Math.max(0, this.matches.length - itemRows);
			const offset = Math.min(Math.max(0, this.selected - Math.floor(itemRows / 2)), maxOffset);

			for (let i = offset; i < Math.min(this.matches.length, offset + itemRows); i++) {
				const skill = this.matches[i]!;
				const active = i === this.selected;
				const hasRider = (this.riders[skill.name] ?? "").trim() !== "";
				body.push(
					theme.fg("accent", active ? "▸ " : "  ") +
						theme.fg(active ? "accent" : hasRider ? "text" : "muted", truncateToWidth(skill.name, width - 6, "…")) +
						(hasRider ? theme.fg("success", " ●") : ""),
				);
			}
		}

		return this.frame(height => body[height], width, rows, ` Skills ${this.matches.length}/${this.skills.length} `);
	}

	/** Right pane: SKILL.md for reference, then the editable extra prompt. */
	private renderRightPane(width: number): string[] {
		const theme = this.theme;
		const skill = this.current();
		const editing = this.focus === "editor";
		const body: string[] = [];
		let title = " Extra prompt ";

		if (!skill) {
			body.push(theme.fg("muted", "No skill matches the filter."));
			while (body.length < MIN_BODY_ROWS - 1) body.push("");
			body.push(this.hintLine(width - 2, false));
		} else {
			const editorRows = this.editorRows(width - 2);
			const referenceRows = Math.max(REFERENCE_MIN_ROWS, MIN_BODY_ROWS - 2 - editorRows.length);
			const reference = this.referenceLines(width - 2, referenceRows);

			body.push(...reference.lines);
			body.push(this.ruleLine(width - 2, editing));
			body.push(...editorRows);
			body.push(this.hintLine(width - 2, reference.scrollable));

			title = reference.scrollable
				? ` ${skill.name} · ${reference.first}-${reference.last}/${reference.total} `
				: ` ${skill.name} `;
		}

		return this.frame(height => body[height], width, body.length + 2, title);
	}

	/**
	 * The skill's own text, greyed out and clipped to `rows`. Page keys move the
	 * window; the wrapped copy is cached because a SKILL.md can be long.
	 */
	private referenceLines(
		width: number,
		rows: number,
	): { lines: string[]; first: number; last: number; total: number; scrollable: boolean } {
		const theme = this.theme;
		this.referenceVisible = rows;

		if (this.reference.trim() === "") {
			return { lines: [theme.fg("dim", " (this skill has no body text)")], first: 0, last: 0, total: 0, scrollable: false };
		}

		const wrapped = this.wrappedReference(width);
		const total = wrapped.length;
		const maxOffset = Math.max(0, total - rows);
		this.referenceOffset = Math.min(Math.max(0, this.referenceOffset), maxOffset);
		const first = this.referenceOffset + 1;
		const last = Math.min(total, this.referenceOffset + rows);
		return {
			lines: wrapped.slice(this.referenceOffset, last).map((line) => theme.fg("muted", line)),
			first,
			last,
			total,
			scrollable: total > rows,
		};
	}

	private wrappedReference(width: number): string[] {
		if (this.wrappedFor !== this.reference || this.wrappedWidth !== width) {
			this.wrapped = wrapTextWithAnsi(this.reference.trim(), width);
			this.wrappedFor = this.reference;
			this.wrappedWidth = width;
		}
		return this.wrapped;
	}

	/** The editable part of the pane. The editor always reserves a 30% window, so
	 *  its own border and the blank rows it leaves behind are dropped. */
	private editorRows(width: number): string[] {
		const rendered = this.editor.render(width).slice(1, -1);
		let end = rendered.length;
		while (end > 1 && isBlankRow(rendered[end - 1]!)) end--;
		return rendered.slice(0, end);
	}

	/** Marks where the extra prompt starts, since it has no frame of its own. */
	private ruleLine(width: number, editing: boolean): string {
		const theme = this.theme;
		const label = truncateToWidth(editing ? " ✎ Extra prompt · editing " : " ✎ Extra prompt · Tab to edit ", width, "");
		const before = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
		const after = Math.max(0, width - visibleWidth(label) - before);
		return theme.fg(editing ? "accent" : "dim", "─".repeat(before) + label + "─".repeat(after));
	}

	private hintLine(width: number, scrollable: boolean): string {
		const theme = this.theme;
		const scroll = scrollable ? " · PgUp/PgDn skill text" : "";
		const hint =
			this.focus === "editor"
				? `Enter done · Shift+Enter newline · Esc close${scroll}`
				: `↑↓ preview · Tab edit · Esc close${scroll}`;
		const status = this.status === "" ? "" : theme.fg("success", `  ${this.status}`);
		return truncateToWidth(theme.fg("dim", hint) + status, width, "");
	}

	/** Wrap one column of cells in its own box; the cell getter is clipped to fit. */
	private frame(cell: (row: number) => string | undefined, width: number, rows: number, title: string): string[] {
		const theme = this.theme;
		const wall = theme.fg("border", "│");
		const inner = width - 2;
		const lines: string[] = [this.boxBorder("╭", "╮", inner, title)];
		for (let i = 0; i < rows - 2; i++) lines.push(wall + pad(truncateToWidth(cell(i) ?? "", inner, ""), inner) + wall);
		lines.push(this.boxBorder("╰", "╯", inner, ""));
		return lines;
	}

	private panelBorder(left: string, inner: number, title: string): string {
		const theme = this.theme;
		const titleWidth = visibleWidth(title);
		const before = Math.max(0, Math.floor((inner - titleWidth) / 2));
		return (
			theme.fg("border", left + "─".repeat(before)) +
			theme.fg("accent", theme.bold(title)) +
			theme.fg("border", "─".repeat(Math.max(0, inner - titleWidth - before)) + (left === "╭" ? "╮" : "╯"))
		);
	}

	private boxBorder(left: string, right: string, inner: number, title: string): string {
		const theme = this.theme;
		const text = truncateToWidth(title, inner, "");
		const textWidth = visibleWidth(text);
		const before = Math.max(0, Math.floor((inner - textWidth) / 2));
		return (
			theme.fg("border", left + "─".repeat(before)) +
			theme.fg("muted", text) +
			theme.fg("border", "─".repeat(Math.max(0, inner - textWidth - before)) + right)
		);
	}

	/** The previewed skill, or undefined when the filter matches nothing. */
	private current(): PanelSkill | undefined {
		return this.matches[this.selected];
	}

	private move(delta: number): void {
		if (this.matches.length === 0) return;
		this.selected = Math.min(Math.max(0, this.selected + delta), this.matches.length - 1);
		this.sync();
		this.refresh();
	}

	/** Re-filter after the search box changed, keeping the highlight when it survives. */
	private refilter(): void {
		const previous = this.current()?.name;
		const query = this.search.getValue().trim().toLowerCase();
		this.matches = query === "" ? this.skills : this.skills.filter((skill) => skill.name.toLowerCase().includes(query));
		const index = this.matches.findIndex((skill) => skill.name === previous);
		this.selected = index === -1 ? 0 : index;
		this.sync();
		this.refresh();
	}

	private edit(): void {
		if (!this.current()) return;
		this.focus = "editor";
		this.editor.focused = true;
		this.search.focused = false;
		this.refresh();
	}

	private scrollReference(delta: number): void {
		this.referenceOffset = Math.max(0, this.referenceOffset + delta);
		this.refresh();
	}

	/** Load the highlighted skill's rider and reference text into the right pane. */
	private sync(): void {
		const skill = this.current();
		this.editor.setText(skill ? this.riders[skill.name] ?? "" : "");
		this.reference = skill ? this.skillBody(skill.name) ?? "" : "";
		this.referenceOffset = 0;
	}

	private commit(): void {
		if (this.focus !== "editor") return;
		const skill = this.current();
		if (!skill) return;
		const text = this.editor.getText();
		if (text === (this.riders[skill.name] ?? "")) return;
		this.riders[skill.name] = text;
		this.save(skill.name, text);
		this.status = text.trim() === "" ? "✓ cleared" : "✓ saved";
	}

	private refresh(): void {
		this.tui.requestRender();
	}
}

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** A rendered row with no visible text and no cursor in it. */
function isBlankRow(line: string): boolean {
	return !line.includes(CURSOR_MARKER) && line.replace(ANSI_PATTERN, "").trim() === "";
}
