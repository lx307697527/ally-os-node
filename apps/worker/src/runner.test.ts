import { PgBoss } from "pg-boss";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { JobFailureAlerter } from "./runner.ts";
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
      { logger },
    );
    await boss.send(name, { n: 42 });

    await expect(received).resolves.toEqual({ n: 42 });
  }, 15_000);

  it("rejects duplicate job names", async () => {
    const job = { name: `dup-${String(Date.now())}`, handler: () => Promise.resolve() };
    await expect(registerJobs(boss, [job, job], { logger })).rejects.toThrow(/duplicate/);
  });

  it("retries a failed job and alerts on every failed attempt", async () => {
    const name = `retry-${String(Date.now())}`;
    const onJobFailure: JobFailureAlerter = vi.fn(async () => {});
    let attempts = 0;
    let resolveSecondAttempt: (attempt: number) => void = () => {};
    const secondAttempt = new Promise<number>((resolve) => {
      resolveSecondAttempt = resolve;
    });

    await registerJobs(
      boss,
      [
        {
          name,
          queue: { retryLimit: 1, retryDelay: 1, retryBackoff: false },
          handler: (_data, { logger: jobLogger }) => {
            attempts += 1;
            if (attempts >= 2) {
              resolveSecondAttempt(attempts);
              return Promise.resolve();
            }
            jobLogger.info("failing on purpose");
            return Promise.reject(new Error("boom"));
          },
        },
      ],
      { logger, onJobFailure },
    );
    await boss.send(name, {});

    await expect(secondAttempt).resolves.toBe(2);
    expect(onJobFailure).toHaveBeenCalledOnce();
    expect(onJobFailure).toHaveBeenCalledWith(
      expect.objectContaining({ job: name, attempt: 1, retryLimit: 1, error: "boom" }),
    );
  }, 25_000);

  it("creates scheduled jobs verbatim from the cron expression", async () => {
    const name = `cron-${String(Date.now())}`;
    await registerJobs(
      boss,
      [{ name, cron: "40 5 * * *", handler: () => Promise.resolve() }],
      { logger },
    );

    const schedules = await boss.getSchedules();
    const schedule = schedules.find((s) => s.name === name);
    expect(schedule).toBeDefined();
    expect(schedule?.cron).toBe("40 5 * * *");
    await boss.unschedule(name);
  });
});
