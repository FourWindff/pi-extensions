/**
 * ask_user: one form for every question the user has to answer.
 *
 * All questions are rendered at once; the user answers them one at a time with
 * a single editor or choice list that walks down the list. After the last
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
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	Text,
	type TUI,
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

			const flow = await ctx.ui.custom<QuestionFlow | null>((tui, theme, _keybindings, done) =>
				createQuestionForm(tui, theme, questions, done, signal),
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
	questions: readonly Question[],
	done: (result: QuestionFlow | null) => void,
	signal: AbortSignal | undefined,
): Component & Focusable & { dispose(): void } {
	let flow = startFlow(questions);
	let cachedLines: string[] | undefined;

	const editor = new Editor(tui, editorTheme(theme));
	editor.onSubmit = (value) => {
		flow = answerQuestion(flow, value);
		editor.setText(isReview(flow) ? "" : draftAnswer(flow));
		refresh();
	};

	function refresh(): void {
		cachedLines = undefined;
		tui.requestRender();
	}

	function handleInput(data: string): void {
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
		if (cachedLines) return cachedLines;

		const renderWidth = Math.max(1, width);
		const lines: string[] = [];
		const review = isReview(flow);

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

		lines.push(theme.fg("accent", "─".repeat(renderWidth)));
		lines.push("");

		for (let index = 0; index < flow.questions.length; index++) {
			if (index > 0) lines.push("");
			const question = flow.questions[index]!;
			const active = !review && index === flow.cursor;
			const answer = answerLabel(question, flow.answers[index]);
			const color = active ? "accent" : answer ? "success" : "muted";
			addWrapped(" ", theme.fg(color, `${index + 1}. ${question.prompt}`));

			if (active && isPicking(flow)) {
				for (let row = 0; row < optionRows(flow); row++) {
					const isEditorRow = row === question.options.length;
					const selected = row === flow.optionIndex;
					const label = isEditorRow ? "✎ Type an answer…" : `${row + 1}. ${question.options[row]}`;
					const rowColor = selected ? "accent" : isEditorRow ? "muted" : "text";
					addWrapped(selected ? theme.fg("accent", "  > ") : "    ", theme.fg(rowColor, label));
				}
			} else if (active) {
				for (const line of editor.render(Math.max(1, renderWidth - 2))) lines.push(` ${line}`);
			} else if (answer || review) {
				addWrapped("    ", theme.fg(answer ? "text" : "dim", answer || "(no answer)"));
			}
		}

		lines.push("");
		if (review) {
			addWrapped(" ", theme.fg("success", "Enter to send") + theme.fg("dim", " · Esc to edit the last answer"));
		} else {
			const step = `Question ${flow.cursor + 1}/${flow.questions.length}`;
			const hasChoices = (currentQuestion(flow)?.options.length ?? 0) > 0;
			const escapeHint =
				isPicking(flow) || !hasChoices
					? flow.cursor === 0
						? "Esc to cancel"
						: "Esc to go back"
					: "Esc for the choices";
			const enterHint = isPicking(flow) ? "↑↓ choose · Enter select" : "Enter to confirm";
			addWrapped(" ", theme.fg("muted", `${step} · ${enterHint} · ${escapeHint}`));
		}
		lines.push(theme.fg("accent", "─".repeat(renderWidth)));

		cachedLines = lines;
		return lines;
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
			editor.focused = value;
		},
		render,
		invalidate: () => {
			cachedLines = undefined;
		},
		handleInput,
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
