// [FEAT-820] No view imports these lists any more: /work-with-us and /thank-you-booked play from
// Vidalytics (lib/vidalytics.js), and Home.jsx imports its two files directly. Kept because
// lib/__tests__/workWithUsMedia.test.js is still the check that the bundled videos are real files.
//
// [BUG-417] The two tiers the /work-with-us hero player serves, and nothing else.
//
// ⚠️ THE HOSTING DECISION LIVES HERE, AND IT IS NOW "BUNDLED BY THE SITE ITSELF".
// #3556 item 4 asked for the legacy tiers to be hosted on publicly readable storage
// rather than committed — 1080 / 720 / 360 plus two thank-you cuts, ~145 MB measured
// on `ally-nutra@origin/main:public/lp/assets/video/` — and this module was built as
// the single place that choice would land:
//
//   finalized-vsl-1080.mp4   64.7 MB      thank-you-vsl-1080.mp4   27.7 MB
//   finalized-vsl-720.mp4    38.6 MB      thank-you-vsl-360.mp4     3.3 MB
//   finalized-vsl-360.mp4    10.8 MB
//
// It shipped with an empty base instead, waiting on a bucket that was never chosen.
// That left the LIVE AD LANDING PAGE rendering a poster and a play button with no
// sources behind them: `networkState` NETWORK_EMPTY, `readyState` HAVE_NOTHING, and
// no console error, because a `<video>` with no `<source>` never makes a request that
// could fail. A visitor saw the first frame at 0:00 and a button that did nothing.
//
// On 2026-09-21 the owner ruled to follow the homepage instead. [FEAT-590] had
// already copied the 720p and 360p tiers into `src/assets/videos/` and was serving
// them out of the site's own bundle — measured live on `/home`: two sources,
// `currentSrc` the 720p asset, duration 249.36 s, no error. `/work-with-us` now does
// the same, against those same two files rather than a second copy of them.
//
// ⚠️ THAT PUTS ABOUT 49 MB OF MP4 IN GIT, which contradicts the one clause of #3556's
// AC-2 reading "视频不在 git 仓内". This is a chosen contradiction, not an oversight:
// the homepage reached that state first, the owner picked consistency with it over
// the written clause, and #3556 carries a comment recording the ruling. The 1080p
// master (64.7 MB) stays out of the repository either way — the player's max on-page
// width is under 720p's needs, and bundling it would cost more than both tiers
// together for no visible gain.
//
// Measured sizes, so the next reader does not have to go and look:
//
//   work-with-us-vsl-720.mp4   38,602,152 bytes
//   work-with-us-vsl-360.mp4   10,784,035 bytes
//
// The poster — `work-with-us-vsl-poster.jpg`, 93 KB, the video's first frame — is
// imported by the view rather than here: it is what stands in front of the player
// before a byte of video is fetched, and it is not a source.
//
// ⚠️ WHY NO REMOTE-BASE SEAM IS LEFT BEHIND. Both states that seam could be in were
// measured, and both were wrong: a `<source>` pointing at an unset base makes the
// browser fetch and fail on every page view, and an empty LIST — what this module
// actually shipped — is a player with nothing to play and nothing to report. A list
// that is always populated is the shape with no state in which the player is broken.
// Moving to a bucket later means editing this file again, which is what it is for.
//
// `lib/__tests__/workWithUsMedia.test.js` holds the half that matters: it imports
// this module, then stats every file the list points at and reads its container
// header, so a deleted asset, a truncated checkout or a git-lfs pointer fails the
// suite instead of shipping another empty player.

import vsl720 from '../assets/videos/work-with-us-vsl-720.mp4';
import vsl360 from '../assets/videos/work-with-us-vsl-360.mp4';
import thankYou360 from '../assets/videos/thank-you-vsl-360.mp4';

/**
 * The `<source>` list, widest first: a browser takes the first entry it can play.
 *
 * The 720p tier is gated on viewport width and the 360p tier deliberately is NOT —
 * an entry with no `media` always matches, which is exactly what makes it the
 * fallback. Gating both would leave a narrow visitor with no source at all, which is
 * the same dead player this module was just repaired out of.
 */
export const VSL_SOURCES = [
  { src: vsl720, type: 'video/mp4', media: '(min-width: 700px)' },
  { src: vsl360, type: 'video/mp4' },
];

/**
 * The thank-you video, shown once a visitor has booked [FEAT-640 / #4156].
 *
 * ONE TIER, and the reason is arithmetic rather than taste. The legacy site cut this
 * video at two sizes only — `thank-you-vsl-1080.mp4` (27.7 MB) and
 * `thank-you-vsl-360.mp4` (3.3 MB); there is no 720p master to bring across. The
 * 2026-09-21 ruling recorded above keeps the 1080p tier out of the repository, and it
 * applies here with more force, not less: this video plays only AFTER someone has
 * booked, so it is the least-watched asset on the page and would be the largest file
 * in the bundle. 3.3 MB ships; 27.7 MB does not.
 *
 * NO `media`, deliberately — an entry with no media query always matches, which is
 * what makes a one-entry list a list that always has a source. This is the same rule
 * the tiers above follow and the exact failure BUG-417 was: gating every entry left
 * some viewports with nothing to play, on a player that reports no error because a
 * `<video>` with no `<source>` never makes a request that could fail.
 *
 * Measured size, so the next reader does not have to look:
 *
 *   thank-you-vsl-360.mp4   3,281,793 bytes
 *
 * The poster — `thank-you-vsl-poster.jpg`, 57 KB — is imported by the view, not here,
 * for the reason the hero's poster is: it stands in front of the player, it is not a
 * source. It is byte-distinct from every other poster in that directory (checked:
 * BUG-417 had to delete a duplicated one).
 */
export const THANK_YOU_SOURCES = [{ src: thankYou360, type: 'video/mp4' }];
