// The "Still there?" overlay (#129 slice 2). The session's final minute is a
// decision the operator must get to see — anything unsaved dies with the
// session — so the warning is non-dismissible: no scrim click, no Escape, no
// ×, one way out, and that way is a SERVER round trip, not a local reset.
// Ported in shape from ally-os apps/allyos SessionTimeoutWarning.tsx, whose
// frame was the @ally-os/ui ModalFrame; this package has not ported
// ModalFrame yet (it returns with the first record route), so the overlay
// rides the same dialog ruling by hand — scrim layer, amber-top panel, one of
// the six dialog widths — and re-seats on the real frame the day it lands.
import type { ReactElement } from "react";

import { Button, Card, Paragraph } from "@ally/ui";

export interface SessionTimeoutWarningProps {
  /** Whole seconds left — a cosmetic countdown; the server owns the decision. */
  secondsRemaining: number;
  onStayLoggedIn: () => void;
}

const OVERLAY =
  "fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-scrim px-6 py-13 outline-none";

export function SessionTimeoutWarning({
  secondsRemaining,
  onStayLoggedIn,
}: SessionTimeoutWarningProps): ReactElement {
  return (
    <div
      className={OVERLAY}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-timeout-title"
      data-testid="session-timeout-warning"
    >
      <Card
        padding="lg"
        className="mt-13 w-full max-w-[var(--width-dialog-560)] border-t-[length:var(--border-accent-width)] border-t-accent shadow-modal"
      >
        <h2
          id="session-timeout-title"
          className="mb-3 font-slab text-[length:var(--fs-h3)] font-semibold tracking-[var(--ls-display)] text-ink"
        >
          Still there?
        </h2>
        <Paragraph>
          You&rsquo;ve been inactive for a while and will be signed out in{" "}
          <strong data-testid="session-timeout-seconds">{secondsRemaining}</strong>{" "}
          second{secondsRemaining === 1 ? "" : "s"} to protect this account.
          Anything you haven&rsquo;t saved will be lost.
        </Paragraph>
        <div className="mt-4">
          <Button data-testid="session-timeout-stay" variant="primary" onClick={onStayLoggedIn}>
            Stay signed in
          </Button>
        </div>
      </Card>
    </div>
  );
}
