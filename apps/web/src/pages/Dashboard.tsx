// The one page Home holds today: where a signed-in operator lands. Slice 1 of
// issue #129 ships the shell, not the rollup — this card is an honest
// placeholder that reads the one live fact the deployment has (the API health
// probe), and the company-wide rollup arrives with the reporting module.
import type { ReactElement } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, Heading, Paragraph } from "@ally/ui";

interface Health {
  status: string;
}

async function fetchHealth(): Promise<Health> {
  const res = await fetch("/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Health;
}

export function Dashboard(): ReactElement {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 10_000 });

  return (
    <div className="w-full" data-page="dashboard" data-testid="dashboard-root">
      <Card>
        <Heading as="h2">Dashboard</Heading>
        <Paragraph className="text-ink-soft">
          The company-wide rollup arrives with the reporting module. Today this
          page holds what the deployment can already answer for:
        </Paragraph>
        <Paragraph data-testid="api-health">
          API status:{" "}
          {health.isPending
            ? "checking…"
            : health.isError
              ? `unavailable (${health.error.message})`
              : health.data.status}
        </Paragraph>
      </Card>
    </div>
  );
}
