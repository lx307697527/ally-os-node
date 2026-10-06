// Notification channel preferences (#116): the one page where an account
// picks its extra delivery channels. In-app is the notification itself (the
// bell is always on — there is nothing to switch); what this page manages is
// the DIGEST: one email a day bundling what is still unread.
//
// Opt-in by default-absence: an account that never opened this page has no
// row server-side and no channel fires — an unconfigured deployment must not
// decide to mail people. The toggle loads once, saves on demand, and every
// failure says itself (a failed load is not "digest off"; a failed save is
// not "saved") — the same honesty discipline as the bell's data layer.
import { useEffect, useState, type ReactElement } from "react";

import { Button, Card } from "@ally/ui";

import {
  createNotificationPreferencesAdapters,
  type NotificationPreferences,
} from "../lib/notification-preferences-client.ts";

const adapters = createNotificationPreferencesAdapters();

export function NotificationSettings(): ReactElement {
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    void adapters.load().then((loaded) => {
      if (!alive) return;
      if (loaded === null) {
        setLoadFailed(true);
        return;
      }
      setPreferences(loaded);
      setDraft(loaded.emailDigest);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function save(): Promise<void> {
    setBusy(true);
    setSaveFailed(false);
    setSaved(false);
    const next = await adapters.save({ emailDigest: draft });
    setBusy(false);
    if (next === null) {
      setSaveFailed(true);
      return;
    }
    setPreferences(next);
    setSaved(true);
  }

  return (
    <div className="mx-auto max-w-xl p-6" data-testid="notification-settings">
      <h1 className="mb-4 font-slab text-[length:var(--text-display-sm)] leading-[var(--lh-display)] font-semibold text-ink">
        Notification settings
      </h1>
      <Card padding="lg">
        {loadFailed ? (
          <p className="text-ui text-ink" data-testid="notification-settings-load-failed">
            Couldn&apos;t load your notification settings. Refresh the page to try again.
          </p>
        ) : (
          <>
            <label
              className="flex cursor-pointer items-start gap-3 text-ui text-ink"
              data-testid="notification-digest-toggle-label"
            >
              <input
                type="checkbox"
                className="mt-1 size-4 accent-[var(--accent)]"
                data-testid="notification-digest-toggle"
                checked={draft}
                disabled={preferences === null || busy}
                onChange={(e) => {
                  setDraft(e.target.checked);
                  setSaved(false);
                }}
              />
              <span>
                <span className="font-medium">Daily email digest</span>
                <span className="mt-1 block text-ink-soft">
                  One email a day (around 9:30 AM US Eastern) bundling the notifications that are
                  still unread. The bell in the app always stays on — this only adds the email.
                </span>
              </span>
            </label>
            <div className="mt-[calc(var(--space-4)+var(--space-1)/2)] flex items-center gap-3">
              <Button
                data-testid="notification-settings-save"
                variant="primary"
                type="button"
                disabled={preferences === null || busy || (preferences.emailDigest === draft && !saveFailed)}
                onClick={() => {
                  void save();
                }}
              >
                {busy ? "Saving…" : "Save"}
              </Button>
              {saved && (
                <span className="text-ui text-ink-soft" data-testid="notification-settings-saved">
                  Saved.
                </span>
              )}
              {saveFailed && (
                <span className="text-err text-ui font-medium" data-testid="notification-settings-save-failed">
                  Couldn&apos;t save just now — try again.
                </span>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
