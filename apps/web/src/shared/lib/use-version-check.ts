// The React seam over the version watch (#129 slice 3): schedule the polls,
// and surface the news as one piece of state — the id of the live build when
// it is newer than this tab's, else null. The banner that renders from it
// (NewVersionBanner) owns the only reload, the operator's click; this hook
// never reloads, and the announcement never retracts — the watch keeps its
// last known live id once seen, and loading the new build is the only way
// out.
import { useEffect, useState } from "react";

import { liveVersionWatch, scheduleVersionWatch } from "./version-watch.ts";

export function useVersionCheck(): string | null {
  const [newBuildId, setNewBuildId] = useState<string | null>(null);

  // One watch per mount: recreating it every render would re-schedule the
  // poll and reset its throttle on each keystroke. Its news IS the state
  // update — a poll finishing is otherwise invisible to React.
  const [watch] = useState(() => liveVersionWatch({ onNews: setNewBuildId }));

  useEffect(() => scheduleVersionWatch(watch), [watch]);

  return newBuildId;
}
