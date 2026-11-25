/**
 * Issues #146-#148: the intake answers a client gives on one booking.
 *
 * A shop's questions live on its profile (`provider_profiles.intake_questions`).
 * When a slot is held, the booking takes its own copy of those questions
 * (`bookings.intake_answers`), each with the client's answer -- blank when
 * the client has not answered yet. Everything after the hold reads that copy
 * alone, so a shop changing its questions later never rewrites an answer
 * already stored on a booking.
 *
 * Who may read the answers is the caller's job (see `services/booking.ts`):
 * the booking's own client, its shop, and an admin resolving a dispute.
 * The public proof page and discovery never read them.
 *
 * Everything here is pure -- no database access.
 */

/** One question a shop asks on every booking. */
export interface IntakeQuestion {
  id: string;
  label: string;
  /** `false` only for a question the shop marked optional. */
  required: boolean;
}

/** One question as asked on one booking, with the client's answer. A
 * question the client has not answered is kept with `answer: ""`, never
 * dropped, so the question itself is never hidden. */
export interface IntakeAnswer {
  questionId: string;
  label: string;
  required: boolean;
  answer: string;
}

/** The longest answer a client may give to one question. */
export const MAX_INTAKE_ANSWER_LENGTH = 500;

/** Bad input to an answer edit. `details` names each offending question,
 * keyed by question id, in plain words the client can act on. */
export class InvalidIntakeAnswersError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>, message = "Some answers can't be saved.") {
    super(message);
    this.name = "InvalidIntakeAnswersError";
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a shop's stored questions. A malformed column (or one written
 * before this feature) reads as "no questions" rather than breaking a
 * booking. Entries with no id or label are skipped. */
export function parseIntakeQuestions(json: string | null | undefined): IntakeQuestion[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const questions: IntakeQuestion[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!id || !label) continue;
    questions.push({ id, label, required: entry.required !== false });
  }
  return questions;
}

/** Reads a booking's stored answers. Same tolerance as
 * {@link parseIntakeQuestions}: malformed reads as no questions, and a
 * missing or non-string answer reads as blank, never omitted. */
export function parseIntakeAnswers(json: string | null | undefined): IntakeAnswer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const answers: IntakeAnswer[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    const questionId = typeof entry.questionId === "string" ? entry.questionId : "";
    const label = typeof entry.label === "string" ? entry.label : "";
    if (!questionId || !label) continue;
    answers.push({
      questionId,
      label,
      required: entry.required !== false,
      answer: typeof entry.answer === "string" ? entry.answer : "",
    });
  }
  return answers;
}

export function serializeIntakeAnswers(answers: IntakeAnswer[]): string {
  return JSON.stringify(
    answers.map(({ questionId, label, required, answer }) => ({ questionId, label, required, answer })),
  );
}

/** Keeps only string values from a client-supplied `{ questionId: answer }`
 * map. Anything that is not an object reads as no answers at all. */
function toAnswerMap(raw: unknown): Map<string, unknown> {
  if (!isRecord(raw)) return new Map();
  return new Map(Object.entries(raw));
}

/**
 * The booking's own copy of the shop's questions, taken at hold time, with
 * whatever answers the client supplied. Answers to questions the shop does
 * not ask are ignored, and an unanswered question is kept blank -- the hold
 * itself never refuses on a blank answer (issue #148: the lock does).
 * Answers are trimmed and capped at {@link MAX_INTAKE_ANSWER_LENGTH}.
 */
export function snapshotIntakeAnswers(questions: IntakeQuestion[], rawAnswers: unknown): IntakeAnswer[] {
  const supplied = toAnswerMap(rawAnswers);
  return questions.map((question) => {
    const value = supplied.get(question.id);
    const answer = typeof value === "string" ? value.trim().slice(0, MAX_INTAKE_ANSWER_LENGTH) : "";
    return { questionId: question.id, label: question.label, required: question.required, answer };
  });
}

/**
 * Issue #147: applies a client's edit to a booking's stored answers. Only
 * the questions this booking was asked can be answered, and the question
 * labels and required flags always come from the booking's own copy, never
 * from the request. A question left out of the edit keeps its current
 * answer. Refuses {@link InvalidIntakeAnswersError} when:
 *
 * - the body is not an object of answers,
 * - an answer names a question this booking was never asked,
 * - an answer is not a string, or is longer than the limit,
 * - a required question would be left blank.
 */
export function applyIntakeAnswerEdit(current: IntakeAnswer[], rawAnswers: unknown): IntakeAnswer[] {
  if (!isRecord(rawAnswers)) {
    throw new InvalidIntakeAnswersError({ answers: "Send the answers as an object of question id to answer." });
  }
  const known = new Map(current.map((entry) => [entry.questionId, entry]));
  const details: Record<string, string> = {};
  const edits = new Map<string, string>();
  for (const [questionId, value] of Object.entries(rawAnswers)) {
    if (!known.has(questionId)) {
      details[questionId] = "This booking does not ask that question.";
      continue;
    }
    if (typeof value !== "string") {
      details[questionId] = "An answer must be text.";
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_INTAKE_ANSWER_LENGTH) {
      details[questionId] = `An answer can be at most ${MAX_INTAKE_ANSWER_LENGTH} characters.`;
      continue;
    }
    edits.set(questionId, trimmed);
  }

  const next = current.map((entry) => (edits.has(entry.questionId) ? { ...entry, answer: edits.get(entry.questionId)! } : entry));
  for (const entry of next) {
    if (entry.required && entry.answer.trim() === "" && edits.has(entry.questionId)) {
      details[entry.questionId] = `"${entry.label}" is required and can't be left blank.`;
    }
  }
  if (Object.keys(details).length > 0) {
    throw new InvalidIntakeAnswersError(details);
  }
  return next;
}

/** Issue #148: every required question on this booking whose answer is
 * blank, in the order the booking asked them. Optional questions never
 * appear here, blank or not. */
export function missingRequiredIntakeAnswers(answers: IntakeAnswer[]): IntakeAnswer[] {
  return answers.filter((entry) => entry.required && entry.answer.trim() === "");
}
