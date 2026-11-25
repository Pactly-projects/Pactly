import { test } from "node:test";
import assert from "node:assert/strict";

import type { IntakeAnswer } from "../api/types";
import { BLANK_ANSWER_LABEL, displayAnswer, lockBlockedReason, missingRequiredLabels } from "./intakeAnswers.js";

const answers: IntakeAnswer[] = [
  { questionId: "a", label: "Any allergies?", required: true, answer: "  " },
  { questionId: "b", label: "Preferred name", required: false, answer: "" },
  { questionId: "c", label: "Goal", required: true, answer: "Strength" },
];

test("a blank answer is shown as 'Not answered', never as nothing", () => {
  assert.equal(displayAnswer(""), BLANK_ANSWER_LABEL);
  assert.equal(displayAnswer("  "), BLANK_ANSWER_LABEL);
  assert.equal(displayAnswer("Sam"), "Sam");
});

test("only blank required questions hold the lock back; optional ones never do", () => {
  assert.deepEqual(missingRequiredLabels(answers), ["Any allergies?"]);
  assert.equal(lockBlockedReason(answers), 'Answer "Any allergies?" before locking your deposit.');
});

test("nothing holds the lock back when every required answer is filled, or there are no questions", () => {
  assert.equal(lockBlockedReason(answers.map((entry) => ({ ...entry, answer: "x" }))), undefined);
  assert.equal(lockBlockedReason([]), undefined);
  assert.equal(lockBlockedReason(undefined), undefined);
});
