import { useEffect, useState } from "react";

import type { IntakeAnswer } from "../api/types";
import { displayAnswer, isBlankAnswer } from "../lib/intakeAnswers";

export interface IntakeAnswersFormProps {
  answers: IntakeAnswer[];
  /** Issue #147: `true` while the booking is only a hold. Once the deposit
   * is locked the answers are shown read-only. */
  editable: boolean;
  /** Saves the client's edits; resolves with the stored answers or throws
   * an error whose message is shown under the form. */
  onSave?: (answers: Record<string, string>) => Promise<void>;
}

/**
 * Issues #146-#148: the shop's intake questions on this one booking. The
 * client fills them in while holding the slot and can change them until the
 * deposit is locked. A required question left blank is flagged here; the
 * lock itself is refused on the server whatever this form says.
 */
export function IntakeAnswersForm({ answers, editable, onSave }: IntakeAnswersFormProps) {
  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(answers));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ text: string; isError: boolean } | undefined>();

  // A refetch (or another tab's save) replaces the stored answers; keep the
  // draft in step unless the client is mid-edit.
  const storedKey = JSON.stringify(answers.map((entry) => [entry.questionId, entry.answer]));
  useEffect(() => {
    setDraft(toDraft(answers));
  }, [storedKey]);

  if (answers.length === 0) {
    return null;
  }

  const dirty = answers.some((entry) => (draft[entry.questionId] ?? "") !== entry.answer);
  const blankRequired = answers.filter((entry) => entry.required && isBlankAnswer(draft[entry.questionId] ?? ""));

  async function handleSave(): Promise<void> {
    if (!onSave) return;
    if (blankRequired.length > 0) {
      setNotice({ text: `Answer ${blankRequired.map((entry) => `"${entry.label}"`).join(", ")} first.`, isError: true });
      return;
    }
    setSaving(true);
    setNotice(undefined);
    try {
      await onSave(draft);
      setNotice({ text: "Answers saved. The shop will see them.", isError: false });
    } catch (error) {
      setNotice({ text: error instanceof Error && error.message ? error.message : "Couldn't save. Try again.", isError: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="booking-summary-note intake-answers">
      <b>QUESTIONS FROM THE SHOP</b>
      <p>Only you, the shop and, if there's a dispute, Pactly can read these answers.</p>
      {editable ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
        >
          {answers.map((entry) => {
            const id = `intake-${entry.questionId}`;
            const value = draft[entry.questionId] ?? "";
            return (
              <label key={entry.questionId} htmlFor={id} className="intake-answers__field">
                <span>
                  {entry.label}
                  {entry.required ? " (required)" : " (optional)"}
                </span>
                <input
                  id={id}
                  type="text"
                  value={value}
                  maxLength={500}
                  required={entry.required}
                  aria-invalid={entry.required && isBlankAnswer(value)}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, [entry.questionId]: event.target.value })}
                />
              </label>
            );
          })}
          <button type="submit" className="button-secondary" disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save answers"}
          </button>
        </form>
      ) : (
        <dl className="intake-answers__list">
          {answers.map((entry) => (
            <div key={entry.questionId}>
              <dt>{entry.label}</dt>
              <dd>{displayAnswer(entry.answer)}</dd>
            </div>
          ))}
        </dl>
      )}
      {notice && (
        <p className={notice.isError ? "escrow-lane__notice escrow-lane__notice--alert" : "escrow-lane__notice"} aria-live="polite">
          {notice.text}
        </p>
      )}
    </div>
  );
}

function toDraft(answers: IntakeAnswer[]): Record<string, string> {
  return Object.fromEntries(answers.map((entry) => [entry.questionId, entry.answer]));
}
