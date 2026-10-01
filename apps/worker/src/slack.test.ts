import { describe, expect, it } from "vitest";
import { createSlackAlerter, formatJobFailure, type FetchLike } from "./slack.ts";

interface RecordedCall {
  url: string;
  init?: { body?: string } | undefined;
}

function recordingFetch(calls: RecordedCall[]): FetchLike {
  return (url, init) =>
    new Promise((resolve) => {
      calls.push({ url, init });
      resolve({ ok: true, status: 200 });
    });
}

describe("createSlackAlerter", () => {
  it("posts the text as JSON to the webhook", async () => {
    const calls: RecordedCall[] = [];
    const alerter = createSlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      fetchImpl: recordingFetch(calls),
    });

    await alerter.send(":rotating_light: job failed");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://hooks.slack.com/services/T/B/X");
    expect(calls[0]?.init).toMatchObject({ method: "POST" });
    expect(JSON.parse(calls[0]?.init?.body ?? "")).toEqual({
      text: ":rotating_light: job failed",
    });
  });

  it("is a no-op without a webhook url (alerting not configured)", async () => {
    const calls: RecordedCall[] = [];
    const alerter = createSlackAlerter({ fetchImpl: recordingFetch(calls) });

    await expect(alerter.send("anything")).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("throws on a non-2xx response so the caller can log the alerting failure", () => {
    const alerter = createSlackAlerter({
      webhookUrl: "https://hooks.slack.com/services/T/B/X",
      fetchImpl: () => Promise.resolve({ ok: false, status: 500 }),
    });

    return expect(alerter.send("msg")).rejects.toThrow(/500/);
  });
});

describe("formatJobFailure", () => {
  it("says the job will retry while attempts remain", () => {
    const text = formatJobFailure({
      job: "fx-rate-sync",
      jobId: "job-1",
      attempt: 1,
      retryLimit: 3,
      error: "boom",
    });
    expect(text).toContain("fx-rate-sync");
    expect(text).toContain("will retry (attempt 1/3)");
    expect(text).toContain("boom");
  });

  it("says the job gave up on the final attempt", () => {
    const text = formatJobFailure({
      job: "fx-rate-sync",
      jobId: "job-1",
      attempt: 4,
      retryLimit: 3,
      error: "boom",
    });
    expect(text).toContain("gave up after all retries");
  });
});
