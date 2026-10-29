/**
 * ask_user: one form for every question the user has to answer.
 *
 * All questions share a scrollable form; the user answers them one at a time
 * with a single editor or choice list that walks down the list. After the last
 * answer the form moves to a review step, and only Enter pressed there is sent
 * back to the model. The state machine lives in questionFlow.ts; this file
 * renders it and registers the tool.
 *
 * The extension stands alone: it registers the tool for every session and only
 * needs a terminal UI to render it, so a session without one (print / json /
 * rpc, which includes subagent child processes) switches it off again at
 * startup. Which modes may use it is a mode-file whitelist decision —
 * `ask_user` sits in plan.md and ask.md, and build carries it like every other
 * registered tool.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	type KeybindingsManager,
	matchesKey,
	parseKey,
	Text,
	type TUI,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	answerLabel,
	answerQuestion,
	closeEditor,
	currentQuestion,
	draftAnswer,
	isPicking,
	isReview,
	moveOption,
	openEditor,
	optionRows,
	pickOption,
	previousQuestion,
	startFlow,
	summarizeAnswers,
	type Question,
	type QuestionFlow,
} from "./questionFlow.ts";

/** Registered name; the mode files whitelist it and this extension drops it without a TUI. */
const QUESTION_TOOL_NAME = "ask_user";

/** Rows the form always takes, docked at the bottom of the terminal. */
const PANEL_ROWS = 14;

interface QuestionDetails {
	questions: Question[];
	/** One answer per question, index-aligned; "(no answer)" for a question confirmed empty. */
	answers: string[];
	cancelled?: boolean;
	/** Set when the form could not run at all (non-interactive mode, no questions). */
	error?: string;
}

export default function askUser(pi: ExtensionAPI): void {
	pi.registerTool({
		name: QUESTION_TOOL_NAME,
		label: "Ask user",
		description:
			"Ask the user questions and wait for their answers. All questions are shown in one form; the user answers them one at a time, reviews the whole set and presses Enter to send it back. A question can offer options to pick from; the user can always type an answer instead. Use this whenever a decision needs the user's input.",
		promptSnippet: "Ask the user questions in one form and wait for their answers",
		promptGuidelines: [
			"Batch every open question into a single ask_user call — the user answers them one at a time in one form.",
			"Give a question options when its likely answers are enumerable; the user can still type a custom answer.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The question to ask, shown in the order the questions are given." }),
					options: Type.Optional(
						Type.Array(Type.String(), {
							description:
								"Answers the user can pick from. Omit to ask for free text; the user can always write their own answer instead of picking.",
						}),
					),
				}),
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions: Question[] = [];
			for (const entry of params.questions) {
				const prompt = entry.question.trim();
				if (prompt.length === 0) continue;
				const options = (entry.options ?? []).map((option) => option.trim()).filter((option) => option.length > 0);
				questions.push({ prompt, options });
			}
			if (ctx.mode !== "tui") {
				return failed(questions, "The question form needs the interactive UI; ask the user in plain text instead.");
			}
			if (questions.length === 0) {
				return failed(questions, "No questions were provided.");
			}

			const flow = await ctx.ui.custom<QuestionFlow | null>(
				(tui, theme, keybindings, done) => createQuestionForm(tui, theme, keybindings, questions, done, signal),
				{ overlay: true, overlayOptions: { width: "100%", maxHeight: PANEL_ROWS, anchor: "bottom-center" } },
			);
			if (!flow) {
				return {
					content: [{ type: "text", text: "The user cancelled the question form." }],
					details: { questions, answers: [], cancelled: true } satisfies QuestionDetails,
				};
			}

			const summary = summarizeAnswers(flow);
			return {
				content: [{ type: "text", text: summary.text }],
				details: { questions, answers: summary.answers } satisfies QuestionDetails,
			};
		},

		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			const count = questions.length;
			const heading =
				theme.fg("toolTitle", theme.bold("ask_user ")) +
				theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			const list = questions
				.map((question, index) => {
					const options = question.options ?? [];
					const suffix = options.length > 0 ? theme.fg("dim", `  (${options.length} options)`) : "";
					return theme.fg("dim", `  ${index + 1}. ${question.question ?? ""}`) + suffix;
				})
				.join("\n");
			return new Text(list ? `${heading}\n${list}` : heading, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
			const lines = details.answers.map(
				(answer, index) => `${theme.fg("success", "✓ ")}${theme.fg("muted", `${index + 1}.`)} ${theme.fg("text", answer)}`,
			);
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	// Registration cannot be undone and the runtime puts every registered tool
	// into the active set, so a session that cannot render the form switches it
	// back off here instead of leaving a tool that can only fail.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") return;
		try {
			const active = pi.getActiveTools();
			if (active.includes(QUESTION_TOOL_NAME)) {
				pi.setActiveTools(active.filter((name) => name !== QUESTION_TOOL_NAME));
			}
		} catch {
			// Too early to touch the tool set: the tool stays visible and a call
			// to it reports the missing UI, which is the same outcome.
		}
	});
}

function failed(questions: Question[], text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: { questions, answers: [], error: text } satisfies QuestionDetails,
	};
}

/**
 * The form itself: every question, one editor or choice list that moves down
 * the list, a review step before anything is sent.
 */
function createQuestionForm(
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	questions: readonly Question[],
	done: (result: QuestionFlow | null) => void,
	signal: AbortSignal | undefined,
): Component & Focusable & { dispose(): void } {
	let flow = startFlow(questions);
	let cachedLines: string[] | undefined;
	let cachedWidth = 0;
	let cachedHeight = 0;
	let scrollTop = 0;
	let contentHeight = 0;
	let viewportHeight = 1;
	let followFocus = true;

	const editor = new Editor(tui, editorTheme(theme));
	editor.onSubmit = (value) => {
		flow = answerQuestion(flow, value);
		editor.setText(isReview(flow) ? "" : draftAnswer(flow));
		refresh();
	};

	function refresh(follow = true): void {
		followFocus = follow;
		cachedLines = undefined;
		tui.requestRender();
	}

	function scrollBy(lines: number): void {
		scrollTop = Math.max(0, Math.min(scrollTop + lines, contentHeight - viewportHeight));
		refresh(false);
	}

	function handleInput(data: string): void {
		const key = parseKey(data);
		const typingText = !isReview(flow) && !isPicking(flow) && key !== undefined && /^(?:shift\+)?(?:space|.)$/u.test(key);
		if (matchesKey(data, Key.pageUp) || (!typingText && keybindings.matches(data, "tui.select.pageUp"))) {
			scrollBy(-Math.max(1, viewportHeight - 1));
			return;
		}
		if (matchesKey(data, Key.pageDown) || (!typingText && keybindings.matches(data, "tui.select.pageDown"))) {
			scrollBy(Math.max(1, viewportHeight - 1));
			return;
		}

		if (isReview(flow)) {
			// The review step is read-only: Enter sends, Esc goes back to editing.
			if (matchesKey(data, Key.enter)) {
				done(flow);
			} else if (matchesKey(data, Key.escape)) {
				flow = previousQuestion(flow);
				editor.setText(draftAnswer(flow));
				refresh();
			}
			return;
		}

		if (isPicking(flow)) {
			if (matchesKey(data, Key.up)) {
				flow = moveOption(flow, -1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				flow = moveOption(flow, 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const question = currentQuestion(flow);
				// The row after the last option opens the editor.
				flow =
					question && flow.optionIndex >= question.options.length
						? openEditor(flow)
						: pickOption(flow, flow.optionIndex);
				editor.setText(draftAnswer(flow));
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				if (flow.cursor === 0) {
					done(null);
					return;
				}
				flow = previousQuestion(flow);
				editor.setText(draftAnswer(flow));
				refresh();
			}
			return;
		}

		if (matchesKey(data, Key.escape)) {
			// A question that offers choices goes back to its list first.
			if ((currentQuestion(flow)?.options.length ?? 0) > 0) {
				flow = closeEditor(flow);
				refresh();
				return;
			}
			if (flow.cursor === 0) {
				done(null);
				return;
			}
			flow = previousQuestion(flow);
			editor.setText(draftAnswer(flow));
			refresh();
			return;
		}

		// Enter reaches answerQuestion through editor.onSubmit.
		editor.handleInput(data);
		refresh();
	}

	function render(width: number): string[] {
		const height = Math.min(PANEL_ROWS, Math.max(1, tui.terminal.rows));
		if (cachedLines && cachedWidth === width && cachedHeight === height) return cachedLines;

		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const review = isReview(flow);
		let focusStart = 0;
		let focusTarget = 0;
		let focusEnd = 0;

		/** Push wrapped text; every line after the first indents under the prefix. */
		const addWrapped = (prefix: string, text: string) => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= renderWidth) {
				lines.push(...wrapTextWithAnsi(prefix + text, renderWidth));
				return;
			}
			const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
			const continuation = " ".repeat(prefixWidth);
			wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : continuation}${line}`));
		};

		for (let index = 0; index < flow.questions.length; index++) {
			if (index > 0) lines.push("");
			const question = flow.questions[index]!;
			const active = !review && index === flow.cursor;
			if (active) focusStart = lines.length;
			const answer = answerLabel(question, flow.answers[index]);
			const color = active ? "accent" : answer ? "success" : "muted";
			addWrapped(" ", theme.fg(color, `${index + 1}. ${question.prompt}`));

			if (active && isPicking(flow)) {
				for (let row = 0; row < optionRows(flow); row++) {
					const isEditorRow = row === question.options.length;
					const selected = row === flow.optionIndex;
					const label = isEditorRow ? "✎ Type an answer…" : `${row + 1}. ${question.options[row]}`;
					const rowColor = selected ? "accent" : isEditorRow ? "muted" : "text";
					const rowStart = lines.length;
					if (renderWidth < 3 && selected) lines.push(theme.fg("accent", ">"));
					const prefix = renderWidth >= 6 ? (selected ? "  > " : "    ") : renderWidth >= 3 ? (selected ? "> " : " ") : "";
					addWrapped(selected ? theme.fg("accent", prefix) : prefix, theme.fg(rowColor, label));
					if (selected) {
						focusTarget = rowStart;
						focusEnd = lines.length - 1;
					}
				}
			} else if (active) {
				const indent = renderWidth > 1 ? " " : "";
				const editorLines = editor.render(Math.max(1, renderWidth - indent.length));
				const cursor = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
				focusTarget = lines.length + Math.max(0, cursor);
				focusEnd = focusTarget;
				for (const line of editorLines) lines.push(`${indent}${line}`);
			} else if (answer || review) {
				addWrapped("    ", theme.fg(answer ? "text" : "dim", answer || "(no answer)"));
			}
		}

		const hasHeader = height >= 3;
		const hasStatus = height >= 2;
		const hasScrollHint = height >= 5 && lines.length > height - Number(hasHeader) - Number(hasStatus);
		contentHeight = lines.length;
		viewportHeight = Math.max(1, height - Number(hasHeader) - Number(hasStatus) - Number(hasScrollHint));
		const questionStart = focusStart;

		if (followFocus) {
			if (review) {
				scrollTop = 0;
			} else {
				if (focusEnd - focusStart >= viewportHeight) focusStart = focusTarget;
				if (focusEnd - focusStart >= viewportHeight) focusEnd = focusStart;
				if (focusStart < scrollTop) scrollTop = focusStart;
				if (focusEnd >= scrollTop + viewportHeight) scrollTop = focusEnd - viewportHeight + 1;
			}
		}
		scrollTop = Math.max(0, Math.min(scrollTop, contentHeight - viewportHeight));

		const output: string[] = [];
		if (hasHeader) {
			const questionHidden = !review && (questionStart < scrollTop || questionStart >= scrollTop + viewportHeight);
			const heading = questionHidden
				? ` ${flow.cursor + 1}. ${currentQuestion(flow)?.prompt.replace(/\s+/g, " ")}`
				: "─".repeat(renderWidth);
			output.push(truncateToWidth(theme.fg("accent", heading), renderWidth));
		}
		const visible = lines.slice(scrollTop, scrollTop + viewportHeight);
		output.push(...visible);
		// Pad the content area to the full panel so the form keeps its fixed height
		// and its status line stays on the last row.
		for (let index = visible.length; index < viewportHeight; index++) output.push("");
		if (hasScrollHint) {
			const position = `${scrollTop + 1}-${Math.min(scrollTop + viewportHeight, contentHeight)}/${contentHeight}`;
			output.push(truncateToWidth(theme.fg("dim", ` PgUp/PgDn scroll · ${position}`), renderWidth));
		}
		if (hasStatus) {
			const hasChoices = (currentQuestion(flow)?.options.length ?? 0) > 0;
			const escapeHint = isPicking(flow) || !hasChoices
				? flow.cursor === 0 ? "Esc cancel" : "Esc back"
				: "Esc choices";
			const status = review
				? "Enter to send · Esc to edit the last answer"
				: `Question ${flow.cursor + 1}/${flow.questions.length} · ${isPicking(flow) ? "↑↓ choose · Enter select" : "Enter confirm"} · ${escapeHint}`;
			output.push(truncateToWidth(theme.fg(review ? "success" : "muted", ` ${status}`), renderWidth));
		}

		cachedWidth = width;
		cachedHeight = height;
		cachedLines = output;
		return output;
	}

	// The turn can be aborted while the form is open; without this the dialog
	// would stay on screen waiting for a key nobody is going to press.
	const onAbort = () => done(null);
	if (signal?.aborted) done(null);
	else signal?.addEventListener("abort", onAbort, { once: true });

	return {
		// Forwarded so the wrapped editor keeps the hardware cursor (and IME)
		// where the user is typing.
		get focused(): boolean {
			return editor.focused;
		},
		set focused(value: boolean) {
			if (editor.focused !== value) cachedLines = undefined;
			editor.focused = value;
		},
		render,
		invalidate: () => {
			cachedLines = undefined;
		},
		handleInput,
		handleMouse: (event: TuiMouseEvent) => {
			if (event.type !== "wheel") return undefined;
			scrollBy(event.wheelDelta ?? 0);
			return { handled: true };
		},
		dispose: () => signal?.removeEventListener("abort", onAbort),
	};
}

function editorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}
