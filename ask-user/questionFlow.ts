/**
 * State machine for the ask_user form: which question is being answered, which
 * option is highlighted, and what has been answered so far.
 *
 * Pure and dependency-free like policy.ts, so the flow can be exercised
 * directly: `node --test questionFlow.test.ts`. question.ts only renders this
 * state and forwards keys.
 *
 * A question either offers choices (the user picks one, or opens the editor
 * through the last row) or is answered by typing. The cursor is shared by both:
 * past the last question it is the review step.
 */

export interface Question {
	readonly prompt: string;
	/** Choices offered under the question; empty means the answer is typed. */
	readonly options: readonly string[];
}

export interface Answer {
	readonly text: string;
	/** True when the user typed it, false when it came from the option list. */
	readonly typed: boolean;
}

const EMPTY_ANSWER: Answer = { text: "", typed: false };

export interface QuestionFlow {
	readonly questions: readonly Question[];
	/** One answer per question, index-aligned. */
	readonly answers: readonly Answer[];
	/** Index of the question being answered, or `questions.length` for the review step. */
	readonly cursor: number;
	/** True while the editor is open for the current question. */
	readonly drafting: boolean;
	/** Highlighted row while picking: an option, or the last row that opens the editor. */
	readonly optionIndex: number;
}

export function startFlow(questions: readonly Question[]): QuestionFlow {
	const first = questions[0];
	return {
		questions: questions.map((question) => ({ prompt: question.prompt, options: [...question.options] })),
		answers: questions.map(() => EMPTY_ANSWER),
		cursor: 0,
		drafting: (first?.options.length ?? 0) === 0,
		optionIndex: 0,
	};
}

export function currentQuestion(flow: QuestionFlow): Question | undefined {
	return flow.questions[flow.cursor];
}

/** The review step is the cursor resting past the last question. */
export function isReview(flow: QuestionFlow): boolean {
	return flow.cursor >= flow.questions.length;
}

/** True while the user is walking the choice list of a question that has one. */
export function isPicking(flow: QuestionFlow): boolean {
	const question = currentQuestion(flow);
	return question !== undefined && question.options.length > 0 && !flow.drafting;
}

/** Rows of the current choice list: every option, then the row that opens the editor. */
export function optionRows(flow: QuestionFlow): number {
	return (currentQuestion(flow)?.options.length ?? 0) + 1;
}

/** ↑/↓ steps the highlight; the type row comes after the last option. */
export function moveOption(flow: QuestionFlow, step: number): QuestionFlow {
	const row = Math.min(optionRows(flow) - 1, Math.max(0, flow.optionIndex + step));
	return row === flow.optionIndex ? flow : { ...flow, optionIndex: row };
}

/** Enter on an option: record it as the answer and move to the next question. */
export function pickOption(flow: QuestionFlow, index: number): QuestionFlow {
	const question = currentQuestion(flow);
	if (isReview(flow) || !question || index < 0 || index >= question.options.length) return flow;
	return advance(replaceAnswer(flow, { text: question.options[index]!, typed: false }));
}

/** Enter on the last row: open the editor, prefiltered with whatever answer exists. */
export function openEditor(flow: QuestionFlow): QuestionFlow {
	return isReview(flow) ? flow : { ...flow, drafting: true };
}

/** Esc while the editor is open on a question that offers choices: back to the list. */
export function closeEditor(flow: QuestionFlow): QuestionFlow {
	return { ...flow, drafting: false };
}

/** Enter in the editor: record what was typed and move to the next question. */
export function answerQuestion(flow: QuestionFlow, text: string): QuestionFlow {
	if (isReview(flow)) return flow;
	return advance(replaceAnswer(flow, { text: text.trim(), typed: true }));
}

/** Esc: one question back; from the review step that is the last question. */
export function previousQuestion(flow: QuestionFlow): QuestionFlow {
	const cursor = Math.max(0, flow.cursor - 1);
	return { ...flow, cursor, ...entryState(flow.questions[cursor], flow.answers[cursor] ?? EMPTY_ANSWER) };
}

/** Text the editor should open with. */
export function draftAnswer(flow: QuestionFlow): string {
	return flow.answers[flow.cursor]?.text ?? "";
}

/** How one answer is shown and reported; "" while the question has no answer yet. */
export function answerLabel(question: Question, answer: Answer | undefined): string {
	if (!answer || answer.text.length === 0) return "";
	// "(wrote)" only tells the model something when there were choices to pick from.
	return answer.typed && question.options.length > 0 ? `(wrote) ${answer.text}` : answer.text;
}

export interface AnswerSummary {
	/** Model-facing Q/A pairs; empty answers are spelled out so they cannot read as missing data. */
	text: string;
	/** One answer per question, index-aligned with the questions. */
	answers: string[];
}

export function summarizeAnswers(flow: QuestionFlow): AnswerSummary {
	const answers = flow.questions.map((question, index) => answerLabel(question, flow.answers[index]) || "(no answer)");
	const text = flow.questions.map((question, index) => `Q: ${question.prompt}\nA: ${answers[index]}`).join("\n\n");
	return { text, answers };
}

function replaceAnswer(flow: QuestionFlow, answer: Answer): QuestionFlow {
	const answers = [...flow.answers];
	answers[flow.cursor] = answer;
	return { ...flow, answers };
}

function advance(flow: QuestionFlow): QuestionFlow {
	const cursor = flow.cursor + 1;
	return { ...flow, cursor, ...entryState(flow.questions[cursor], flow.answers[cursor] ?? EMPTY_ANSWER) };
}

/**
 * How a question is entered by stepping to it: a typed answer reopens the
 * editor prefilled, a picked one puts the highlight back on that option, and
 * anything else starts on the first row.
 */
function entryState(question: Question | undefined, answer: Answer): { drafting: boolean; optionIndex: number } {
	const picked = question?.options.indexOf(answer.text) ?? -1;
	return {
		drafting: (question?.options.length ?? 0) === 0 || (answer.typed && answer.text.length > 0),
		optionIndex: picked >= 0 ? picked : 0,
	};
}
