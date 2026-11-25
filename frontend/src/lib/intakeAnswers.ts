import type { IntakeAnswer } from "../api/types";

/** Issue #146: shown under a question the client has not answered, so the
 * question is never hidden. */
export const BLANK_ANSWER_LABEL = "Not answered";

export function isBlankAnswer(answer: string): boolean {
  return answer.trim() === "";
}

/** Issue #146: what to print for one stored answer. */
export function displayAnswer(answer: string): string {
  return isBlankAnswer(answer) ? BLANK_ANSWER_LABEL : answer;
}

/** Issue #148: the labels of required questions still blank, in the order
 * the booking asked them -- what the lock button names when it is held
 * back. Optional questions never appear here, blank or not. */
export function missingRequiredLabels(answers: IntakeAnswer[] | undefined): string[] {
  return (answers ?? []).filter((entry) => entry.required && isBlankAnswer(entry.answer)).map((entry) => entry.label);
}

/** Issue #148: the sentence the lock button shows while required answers
 * are missing, or `undefined` when nothing is missing. */
export function lockBlockedReason(answers: IntakeAnswer[] | undefined): string | undefined {
  const missing = missingRequiredLabels(answers);
  if (missing.length === 0) return undefined;
  return `Answer ${missing.map((label) => `"${label}"`).join(", ")} before locking your deposit.`;
}
