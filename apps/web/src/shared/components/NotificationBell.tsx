// The header notification bell (#129 slice 4). Ported from ally-os
// NotificationBell.tsx, reduced to this repo's API face: the summary is ONE
// request (FEAT-391), writes re-read from the server instead of clearing
// locally, and the poll pauses while the tab is hidden (use-visible-poll).
//
// RULINGS KEPT FROM THE PORT:
//  · POLLING, NOT A SUBSCRIPTION — 60s, visible tabs only. The realtime bus
//    (#30) has no notifications publisher yet; when one lands the bell may
//    move, and until then the poll is the whole mechanism.
//  · A FAILED READ IS NOT ZERO — a failed summary keeps the last good state
//    on screen and prints an honest note in the panel; an empty inbox is a
//    claim, not a fallback.
//  · THE SHELL GOES AND GETS NOTHING — data arrives via `adapters`, built by
//    the composition root (ShellHost). This component never imports a client.
//
// LIVE PUSH (#110 slice 2): the publisher landed, so the bell now takes an
// optional `live` channel (also built by the composition root) and re-reads
// on its nudge — realtime became the PRIMARY trigger, and the 60s visible
// poll DEMOTED to the fallback that catches what at-most-once delivery (and
// a dead socket) drops. Same refresh, same generation guard, no new data
// path: a nudge without a following read changes nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useNavigate } from "react-router-dom";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@ally/ui";

import {
  describeAge,
  describeNotification,
  unreadBadge,
  type NotificationRow,
} from "../lib/notification-face.ts";
import type { NotificationLiveChannel } from "../lib/notification-live.ts";
import type { NotificationAdapters } from "../lib/notifications-client.ts";
import { useVisiblePoll } from "../lib/use-visible-poll.ts";

/** How often the bell re-reads on its own. Old NOTIFICATION_POLL_MS. */
export const NOTIFICATION_POLL_MS = 60_000;

export function NotificationBell({
  adapters,
  live,
  pollMs = NOTIFICATION_POLL_MS,
}: {
  adapters: NotificationAdapters;
  /**
   * Live push channel (#110 slice 2), built by the composition root. Absent
   * = poll-only (the #129 slice 4 behavior).
   */
  live?: NotificationLiveChannel | undefined;
  /** `0` disables the timer — what the tests use. */
  pollMs?: number;
}): ReactElement {
  const navigate = useNavigate();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  // `null` = no read has landed yet; the badge stays off until a real count
  // arrives. A FAILED read leaves this exactly where it was.
  const [unread, setUnread] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  // Guards against an older in-flight read landing after a newer one: the
  // bell re-reads on a timer, on open and after every write, so overlapping
  // runs are ordinary here rather than rare.
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    const summary = await adapters.summary();
    if (mine !== generation.current) return;
    if (summary === null) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setRows(summary.recent);
    setUnread(summary.unreadCount);
  }, [adapters]);

  // The mount read is the initial load, not a poll — deliberately ungated.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useVisiblePoll(
    () => refresh(),
    pollMs,
    // Coming back to the tab is a read trigger, same as opening the dropdown.
    { onReturn: () => refresh() },
  );

  // The live nudge (#110 slice 2) is just another refresh trigger — the same
  // generation guard absorbs it colliding with a poll or a write re-read.
  useEffect(() => {
    if (live === undefined) return undefined;
    return live.subscribe(() => {
      void refresh();
    });
  }, [live, refresh]);

  const openBell = useCallback((next: boolean): void => {
    setOpen(next);
    if (next) void refresh();
  }, [refresh]);

  const markRead = useCallback((id: string): void => {
    void (async () => {
      await adapters.markRead(id);
      await refresh();
    })();
  }, [adapters, refresh]);

  const markAllRead = useCallback((): void => {
    void (async () => {
      await adapters.markAllRead();
      await refresh();
    })();
  }, [adapters, refresh]);

  const badge = unreadBadge(unread ?? 0);

  return (
    <span data-testid="notification-bell" className="relative inline-flex">
      <Menu open={open} onOpenChange={openBell}>
        <MenuTrigger
          testId="notification-bell-trigger"
          className="relative grid size-8 cursor-pointer place-items-center rounded-pill text-[var(--text-on-navy-soft)] hover:bg-[var(--surface-navy-2)] hover:text-[var(--text-on-navy)]"
        >
          <svg
            width={16}
            height={16}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
          >
            <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
            <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          </svg>
          {badge !== null && (
            <span
              data-testid="notification-badge"
              aria-hidden="true"
              className="absolute -top-0.5 right-0 grid h-[16px] min-w-[16px] place-items-center rounded-pill bg-accent px-1 font-mono text-[10px] font-semibold leading-none text-accent-ink"
            >
              {badge}
            </span>
          )}
          <span className="sr-only">Notifications</span>
        </MenuTrigger>
        <MenuPopup align="end">
          <div
            data-testid="notification-panel"
            className="flex w-[320px] flex-col"
            role="region"
            aria-label="Notifications"
          >
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="font-mono text-[length:var(--fs-meta)] tracking-[var(--ls-crumb)] text-ink-soft uppercase">
                Notifications
              </span>
              {unread !== null && unread > 0 && (
                <button
                  type="button"
                  data-testid="notification-mark-all"
                  onClick={markAllRead}
                  className="cursor-pointer border-0 bg-transparent p-0 text-ui-sm font-semibold text-link underline underline-offset-2 hover:text-link-hover"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {rows.length === 0 ? (
                <p className="px-3 py-4 text-ui-sm text-ink-soft" data-testid="notification-empty">
                  {failed
                    ? "Couldn't load notifications. They will retry on the next check."
                    : "No notifications yet."}
                </p>
              ) : (
                rows.map((row) => {
                  const face = describeNotification(row);
                  return (
                    <MenuItem
                      key={row.id}
                      keepOpen
                      testId="notification-row"
                      // The click-through (#110 slice 1): a row with a place
                      // to go takes it — unread is marked on the way and the
                      // router walks to the task (the ?comment= param lands
                      // on the mentioned comment). Nowhere to go = the old
                      // read-only click.
                      onClick={() => {
                        if (!row.isRead) markRead(row.id);
                        if (face.href !== null) navigate(face.href);
                      }}
                      dataAttributes={{
                        "data-read": String(row.isRead),
                      }}
                    >
                      <span className="flex min-w-0 flex-col gap-0.5 py-0.5">
                        <span
                          className={
                            row.isRead
                              ? "text-ui-sm leading-[var(--lh-ui)] text-ink-soft"
                              : "text-ui-sm font-medium leading-[var(--lh-ui)] text-ink"
                          }
                        >
                          {!row.isRead && (
                            <span
                              aria-hidden="true"
                              className="mr-1.5 inline-block size-[6px] rounded-pill bg-accent align-middle"
                            />
                          )}
                          {face.title}
                        </span>
                        {face.detail !== "" && (
                          <span className="text-ui-sm leading-[var(--lh-ui)] text-ink-soft">
                            {face.detail}
                          </span>
                        )}
                        <span className="text-meta text-ink-soft">{describeAge(row.createdAt)}</span>
                      </span>
                    </MenuItem>
                  );
                })
              )}
            </div>
            {failed && rows.length > 0 && (
              <p className="border-t border-line px-3 py-2 text-meta text-ink-soft" data-testid="notification-stale">
                Couldn't refresh just now — showing what was loaded.
              </p>
            )}
            <div className="border-t border-line px-3 py-2">
              {/* 渠道偏好的发现入口（#116）：通知面的门口指向通知设置，
                  keepOpen 不设——点了就走，菜单随路由跳转收起。 */}
              <button
                type="button"
                data-testid="notification-settings-link"
                onClick={() => {
                  navigate("/settings/notifications");
                }}
                className="cursor-pointer border-0 bg-transparent p-0 text-meta text-link underline underline-offset-2 hover:text-link-hover"
              >
                Notification settings
              </button>
            </div>
          </div>
        </MenuPopup>
      </Menu>
    </span>
  );
}
