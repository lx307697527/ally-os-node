import { PgBoss } from "pg-boss";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerJobs } from "./runner.ts";

// 集成测试：需要真实 PostgreSQL。CI 里由 postgres service 提供；
// 本地没设 DATABASE_URL 时自动跳过。
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("registerJobs (integration)", () => {
  let boss: PgBoss;
  const logger = pino({ level: "silent" });

  beforeAll(async () => {
    boss = new PgBoss({ connectionString: databaseUrl ?? "", schema: "pgboss_test" });
    await boss.start();
  });

  afterAll(async () => {
    await boss.stop({ graceful: false });
  });

  it("delivers a sent job to its handler", async () => {
    const name = `test-${String(Date.now())}`;
    let resolveReceived: (data: object) => void = () => {};
    const received = new Promise<object>((resolve) => {
      resolveReceived = resolve;
    });

    await registerJobs(
      boss,
      [
        {
          name,
          handler: (data) => {
            resolveReceived(data);
            return Promise.resolve();
          },
        },
      ],
      logger,
    );
    await boss.send(name, { n: 42 });

    await expect(received).resolves.toEqual({ n: 42 });
  }, 15_000);

  it("rejects duplicate job names", async () => {
    const job = { name: `dup-${String(Date.now())}`, handler: () => Promise.resolve() };
    await expect(registerJobs(boss, [job, job], logger)).rejects.toThrow(/duplicate/);
  });
});
