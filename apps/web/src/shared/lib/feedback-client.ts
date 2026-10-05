// Submitting a feedback report (#129 slice 4). The API owns the truth; this
// client is a thin fetch + parse. EVERY failure degrades to a spoken result —
// never an exception across the form's event handler — and the words a 400
// produces are the form's, not the server's internals (the API returns a bare
// error code by design).
import { z } from "zod";

import { feedbackPayload, type FeedbackDraft } from "./feedback-draft.ts";

const doneSchema = z.object({ reportNumber: z.string().regex(/^BR-[0-9a-f]{8}$/) });

export type SubmitFeedbackResult =
  | { ok: true; reportNumber: string }
  | { ok: false; kind: "invalid" | "unreachable"; message: string };

/** Never rejects. */
export async function submitFeedback(
  draft: FeedbackDraft,
  fetchFn: typeof fetch = fetch,
): Promise<SubmitFeedbackResult> {
  try {
    const res = await fetchFn("/api/feedback-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(feedbackPayload(draft)),
    });
    if (res.status === 400) {
      return { ok: false, kind: "invalid", message: "Some fields need attention before this can be sent." };
    }
    if (!res.ok) {
      return { ok: false, kind: "unreachable", message: "Couldn't submit right now. Try again in a moment." };
    }
    const done = doneSchema.parse(await res.json());
    return { ok: true, reportNumber: done.reportNumber };
  } catch {
    return { ok: false, kind: "unreachable", message: "Couldn't reach the server. Try again in a moment." };
  }
}
