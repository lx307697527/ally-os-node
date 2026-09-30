import { useQuery } from "@tanstack/react-query";

interface Health {
  status: string;
}

async function fetchHealth(): Promise<Health> {
  const res = await fetch("/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Health;
}

export function App() {
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 10_000 });

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 32 }}>
      <h1>Ally OS</h1>
      <p>
        API 状态：
        {health.isPending ? "检查中…" : health.isError ? `不可用（${health.error.message}）` : health.data.status}
      </p>
    </main>
  );
}
