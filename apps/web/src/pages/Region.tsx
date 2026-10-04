// A region's own overview page. Ported from ally-os apps/allyos Region.tsx
// (#129 slice 1).
//
// Every top-bar tab must open something. In this repo every business region is
// still empty, so every tab lands here and the region's own `note` from
// RAIL_GROUPS is the page content — one description, in one table, that cannot
// drift from what the rail prints. Written generically: the region to arrive
// gets real pages and leaves this behaviour behind with no new file.
import type { ReactElement } from "react";
import { useParams } from "react-router-dom";

import { Card, Heading, Paragraph } from "@ally/ui";
import { RAIL_GROUPS } from "../shared/shell/rail-groups.ts";

export function Region(): ReactElement {
  const { region } = useParams();
  const group = RAIL_GROUPS.find((entry) => entry.key === region);

  if (!group) {
    // An unknown key is a typed URL, not a broken link from inside the app: the
    // tabs are derived from the same table this reads. Said plainly rather than
    // redirected, so the address bar still shows what was asked for.
    return (
      <div className="w-full" data-page="allyos-region" data-testid="region-unknown">
        <Card>
          <Heading as="h2">No such region</Heading>
          <Paragraph className="text-ink-soft">
            The regions are on the bar above. This address does not name one of them.
          </Paragraph>
        </Card>
      </div>
    );
  }

  return (
    <div
      className="w-full"
      data-page="allyos-region"
      data-region={group.key}
      data-testid="region-root"
    >
      <Card>
        <Heading as="h2">{group.label}</Heading>
        <Paragraph className="text-ink-soft" data-testid="region-note">
          {group.note}
        </Paragraph>
      </Card>
    </div>
  );
}
