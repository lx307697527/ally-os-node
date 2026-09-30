import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";

const logger = pino({ level: "silent" });

function makeApp(checkDatabase: () => Promise<void>) {
  return createApp({ logger, corsOrigins: ["http://localhost:5173"], checkDatabase });
}

describe("health routes", () => {
  it("GET /health returns ok", async () => {
    const res = await makeApp(async () => {}).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /ready returns 503 when the database is down", async () => {
    const res = await makeApp(() => Promise.reject(new Error("down"))).request("/ready");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
  });

  it("GET /ready returns 200 when the database responds", async () => {
    const res = await makeApp(async () => {}).request("/ready");
    expect(res.status).toBe(200);
  });

  it("unknown routes return JSON 404", async () => {
    const res = await makeApp(async () => {}).request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
