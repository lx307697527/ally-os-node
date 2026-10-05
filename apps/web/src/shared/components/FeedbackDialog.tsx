// The submit-feedback dialog (#129 slice 4). ONE form component, opened from
// the session menu — the same single-component ruling the old FeedbackForm
// made when it replaced two drifted copies (widget + page). The old widget
// floated OUTSIDE the shell so a crashed page could still report; this repo's
// dialog lives in the shell's composition root until there is a surface that
// renders while the app itself is broken.
//
// The frame hand-rides the dialog ruling (scrim, amber-top panel, one width)
// exactly like SessionTimeoutWarning — ModalFrame hasn't ported yet; both
// re-seat the day it lands.
//
// testids follow the old form: fb-form / fb-field-<name> / fb-submit /
// fb-error / fb-done / fb-number / fb-close.
import { useState } from "react";
import type { ReactElement, SyntheticEvent } from "react";

import { Button, Card, Input } from "@ally/ui";

import { submitFeedback } from "../lib/feedback-client.ts";
import {
  feedbackDraftProblems,
  FEEDBACK_PRIORITIES,
  FORM_FEEDBACK_TYPES,
  type FeedbackDraft,
  type FeedbackPriority,
  type FormFeedbackType,
} from "../lib/feedback-draft.ts";

const OVERLAY =
  "fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-scrim px-6 py-13 outline-none";

const TYPE_LABELS: Record<FormFeedbackType, string> = {
  bug_report: "Bug report",
  feature_request: "Feature request",
};

const PRIORITY_LABELS: Record<FeedbackPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const EMPTY_DRAFT: FeedbackDraft = {
  type: "bug_report",
  title: "",
  description: "",
  stepsToReproduce: "",
  priority: "medium",
};

export function FeedbackDialog({
  onClose,
  fetchFn,
}: {
  onClose: () => void;
  /** Injectable for tests; production uses the global fetch. */
  fetchFn?: typeof fetch;
}): ReactElement {
  const [draft, setDraft] = useState<FeedbackDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [sentNumber, setSentNumber] = useState<string | null>(null);

  function field<K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]): void {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const found = feedbackDraftProblems(draft);
    setProblems(found);
    if (found.length > 0) return;
    setBusy(true);
    const result = await submitFeedback(draft, fetchFn);
    setBusy(false);
    if (result.ok) {
      setSentNumber(result.reportNumber);
      return;
    }
    setProblems([result.message]);
  }

  return (
    <div className={OVERLAY} role="dialog" aria-modal="true" aria-labelledby="feedback-title" data-testid="feedback-dialog">
      <Card
        padding="lg"
        className="mt-13 w-full max-w-[var(--width-dialog-560)] border-t-[length:var(--border-accent-width)] border-t-accent shadow-modal"
      >
        {sentNumber !== null ? (
          <div data-testid="fb-done">
            <h2
              id="feedback-title"
              className="mb-3 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink"
            >
              Thanks — report filed
            </h2>
            <p className="text-body text-ink-soft">
              Your report number is{" "}
              <strong data-testid="fb-number" className="font-mono text-ink">
                {sentNumber}
              </strong>
              . Keep it if you want to refer to this report later.
            </p>
            <div className="mt-4">
              <Button data-testid="fb-close" variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <h2
              id="feedback-title"
              className="mb-1 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink"
            >
              Submit feedback
            </h2>
            <p className="mb-4 text-body text-ink-soft">
              Found something broken, or something that should work better? Tell us — it goes
              straight to the team.
            </p>
            <form data-testid="fb-form" onSubmit={(event) => void onSubmit(event)} noValidate>
              <fieldset className="mb-3 border-0 p-0">
                <legend className="mb-1 text-ui-sm font-semibold text-ink">What is it?</legend>
                <div className="flex gap-4">
                  {FORM_FEEDBACK_TYPES.map((type) => (
                    <label key={type} className="inline-flex cursor-pointer items-center gap-2 text-ui text-ink">
                      <input
                        type="radio"
                        name="fb-type"
                        data-testid={`fb-field-type-${type}`}
                        checked={draft.type === type}
                        onChange={() => { field("type", type); }}
                        className="accent-[var(--control-navy)]"
                      />
                      {TYPE_LABELS[type]}
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="mb-3 block">
                <span className="mb-1 block text-ui-sm font-semibold text-ink">Title</span>
                <Input
                  data-testid="fb-field-title"
                  value={draft.title}
                  onChange={(event) => { field("title", event.target.value); }}
                  placeholder="One line that says what happened"
                  maxLength={200}
                />
              </label>

              <label className="mb-3 block">
                <span className="mb-1 block text-ui-sm font-semibold text-ink">Description</span>
                <textarea
                  data-testid="fb-field-description"
                  value={draft.description}
                  onChange={(event) => { field("description", event.target.value); }}
                  rows={4}
                  placeholder="What happened, and what did you expect?"
                  className="block w-full rounded-small border border-line bg-card px-3 py-2 text-ui leading-[var(--lh-ui)] text-ink outline-none placeholder:text-ink-soft focus:border-[var(--control-navy)]"
                />
              </label>

              {draft.type === "bug_report" && (
                <label className="mb-3 block">
                  <span className="mb-1 block text-ui-sm font-semibold text-ink">
                    Steps to reproduce <span className="font-normal text-ink-soft">(optional)</span>
                  </span>
                  <textarea
                    data-testid="fb-field-steps"
                    value={draft.stepsToReproduce}
                    onChange={(event) => { field("stepsToReproduce", event.target.value); }}
                    rows={3}
                    placeholder="1. Open … 2. Click …"
                    className="block w-full rounded-small border border-line bg-card px-3 py-2 text-ui leading-[var(--lh-ui)] text-ink outline-none placeholder:text-ink-soft focus:border-[var(--control-navy)]"
                  />
                </label>
              )}

              <label className="mb-4 block">
                <span className="mb-1 block text-ui-sm font-semibold text-ink">Priority</span>
                <select
                  data-testid="fb-field-priority"
                  value={draft.priority}
                  onChange={(event) => { field("priority", event.target.value as FeedbackPriority); }}
                  className="block w-auto cursor-pointer rounded-small border border-line bg-card px-3 py-2 text-ui text-ink outline-none focus:border-[var(--control-navy)]"
                >
                  {FEEDBACK_PRIORITIES.map((priority) => (
                    <option key={priority} value={priority}>
                      {PRIORITY_LABELS[priority]}
                    </option>
                  ))}
                </select>
              </label>

              {problems.length > 0 && (
                <ul className="mb-3 list-disc pl-5 text-ui-sm text-err" data-testid="fb-error">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}

              <div className="flex items-center gap-3">
                <Button type="submit" data-testid="fb-submit" variant="primary" disabled={busy}>
                  {busy ? "Sending…" : "Send report"}
                </Button>
                <Button type="button" variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </div>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}
