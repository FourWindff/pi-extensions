/**
 * Behaviour tests for the ask_user form flow: given picks and typed answers,
 * what the user sees at each step and what the model receives.
 *
 * Run with `node --test questionFlow.test.ts` (Node 24 strips the types itself).
 */

import assert from "node:assert/strict";
import test from "node:test";
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
} from "./questionFlow.ts";

function question(prompt: string, ...options: string[]): Question {
	return { prompt, options };
}

test("a question without options opens the editor and Enter moves on", () => {
	let flow = startFlow([question("database?"), question("deadline?")]);
	assert.equal(isPicking(flow), false);
	assert.equal(isReview(flow), false);

	flow = answerQuestion(flow, " postgres ");
	assert.equal(draftAnswer(flow), "");
	flow = answerQuestion(flow, "friday");

	assert.equal(isReview(flow), true);
	assert.deepEqual(summarizeAnswers(flow).answers, ["postgres", "friday"]);
});

test("a question with options is picked from a list whose last row opens the editor", () => {
	let flow = startFlow([question("keep compatibility?", "yes", "no"), question("notes?")]);
	assert.equal(isPicking(flow), true, "the first question offers choices");
	assert.equal(optionRows(flow), 3, "two options plus the editor row");

	// ↓ twice lands on the editor row and stays there.
	flow = moveOption(flow, 2);
	assert.equal(flow.optionIndex, 2);
	assert.equal(moveOption(flow, 1).optionIndex, 2);

	flow = moveOption(flow, -1); // back onto "no"
	flow = pickOption(flow, flow.optionIndex);
	assert.equal(isPicking(flow), false, "the next question is free text");
	assert.deepEqual(flow.answers[0], { text: "no", typed: false });

	flow = answerQuestion(flow, "drop the old path later");
	assert.equal(isReview(flow), true);
	assert.equal(summarizeAnswers(flow).text, "Q: keep compatibility?\nA: no\n\nQ: notes?\nA: drop the old path later");
});

test("typing instead of picking is reported as written", () => {
	let flow = startFlow([question("database?", "postgres", "mysql")]);
	flow = openEditor(flow);
	flow = answerQuestion(flow, "sqlite, in-memory");
	assert.equal(isReview(flow), true);
	assert.equal(summarizeAnswers(flow).text, "Q: database?\nA: (wrote) sqlite, in-memory");
});

test("Esc on a picked answer highlights it, on a typed one reopens the editor", () => {
	let flow = startFlow([question("a?", "one", "two"), question("b?")]);
	flow = pickOption(flow, 1);
	flow = answerQuestion(flow, "typed b");

	flow = previousQuestion(flow); // review → b
	assert.equal(currentQuestion(flow)?.prompt, "b?");
	assert.equal(draftAnswer(flow), "typed b");

	flow = previousQuestion(flow); // b → a
	assert.equal(currentQuestion(flow)?.prompt, "a?");
	assert.equal(draftAnswer(flow), "two");
	assert.equal(flow.optionIndex, 1, "the highlight is back on the picked option");
	assert.equal(isPicking(flow), true);

	// Typing over the pick replaces it and marks it as written.
	flow = openEditor(flow);
	flow = answerQuestion(flow, "neither");
	assert.equal(closeEditor(flow).drafting, false);
	assert.deepEqual(flow.answers[0], { text: "neither", typed: true });
});

test("stepping back stops at the first question and blanks reach the model as (no answer)", () => {
	let flow = startFlow([question("a?", "yes", "no"), question("b?")]);
	flow = closeEditor(flow); // the caller's Esc handler
	flow = pickOption(flow, 0);
	flow = answerQuestion(flow, "   ");

	assert.equal(isReview(flow), true);
	assert.deepEqual(summarizeAnswers(flow).answers, ["yes", "(no answer)"]);
	// The caller cancels the dialog when the cursor is already at the first question.
	assert.equal(previousQuestion(previousQuestion(flow)).cursor, 0);
});

test("empty answers show as blank in the form and (no answer) in the result", () => {
	const questionWithoutChoice = question("anything?");
	assert.equal(answerLabel(questionWithoutChoice, { text: "", typed: true }), "");
	assert.equal(answerLabel(questionWithoutChoice, { text: "x", typed: true }), "x");
	assert.equal(answerLabel(question("pick?", "a"), { text: "x", typed: true }), "(wrote) x");
	assert.equal(answerLabel(question("pick?", "a"), { text: "a", typed: false }), "a");
});
