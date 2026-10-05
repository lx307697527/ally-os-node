// The refresh prompt (#129 slice 3): the one piece of UI the version watch
// can raise. A tab that outlived a deployment keeps running old code until
// it reloads, so the news must be visible and the action one click away —
// but the reload itself is NEVER automatic (the old system's ruling: a timer
// that reloads can land mid-form and destroy unsaved work). The operator
// picks the moment. Dismiss is deliberately absent: staleness does not
// un-happen, and the next poll would just re-raise it.
import type { ReactElement } from "react";

import { Button, Paragraph } from "@ally/ui";

const BANNER =
  "fixed bottom-6 right-6 z-50 flex items-center gap-4 rounded-card border border-line bg-card px-4 py-3 shadow-modal";

export interface NewVersionBannerProps {
  onRefresh: () => void;
}

export function NewVersionBanner({ onRefresh }: NewVersionBannerProps): ReactElement {
  return (
    <div className={BANNER} role="status" data-testid="new-version-banner">
      <Paragraph className="my-0">A new version of Ally OS is available.</Paragraph>
      <Button data-testid="new-version-refresh" variant="primary" size="sm" onClick={onRefresh}>
        Refresh now
      </Button>
    </div>
  );
}
