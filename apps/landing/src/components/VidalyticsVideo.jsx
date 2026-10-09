import { useEffect, useRef, useState } from 'react';

import { startVidalyticsEmbed, vidalyticsPlayer } from '../lib/vidalytics.js';

/**
 * [FEAT-820] One Vidalytics video: the empty box its embed code starts with, and the
 * player started into it.
 *
 * There is deliberately NO fallback video (owner, 2026-09-30: keep the page that books
 * meetings light and free of moving parts). When Vidalytics cannot load at all (an ad
 * blocker, an outage) this renders nothing and calls `onFailed(true)`, so the page can
 * fold its frame away instead of showing an empty box.
 *
 * `onPlayer` receives the Player API object once it exists (play, pause, paused, on…),
 * for a page that must steer it — /work-with-us pauses it while the booking calendar is
 * on screen.
 */
export default function VidalyticsVideo({ embed, onPlayer, onFailed, testId }) {
  const box = useRef(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    let live = true;
    startVidalyticsEmbed(embed, node).catch((cause) => {
      // Not swallowed: the box folds away, and the reason is kept here.
      console.warn('[FEAT-820] Vidalytics did not load; the video box is hidden.', cause);
      if (!live) return;
      setFailed(true);
      if (onFailed) onFailed(true);
    });
    const ready = vidalyticsPlayer(embed, node);
    if (onPlayer) ready.then((player) => { if (live) onPlayer(player); });
    return () => {
      live = false;
      // A real unmount (leaving the page) stops the video; StrictMode's rehearsal, which
      // keeps the same element in the document, must not.
      ready.then((player) => { if (!node.isConnected) player.pause('unmount'); });
    };
  }, [embed, onPlayer, onFailed]);

  if (failed) return null;
  return (
    <div
      id={embed.embedId}
      ref={box}
      className="vidalytics-embed"
      // The embed code's own box: full width, 16:9 by top padding.
      style={{ width: '100%', position: 'relative', paddingTop: '56.25%' }}
      data-testid={testId}
    />
  );
}
