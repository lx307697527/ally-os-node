import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { SessionData } from "./auth/session.ts";

const logger = pino({ level: "silent" });

const fakeSession: SessionData = {
  user: { id: "u-1", email: "user@example.com", name: "User", emailVerified: true },
  session: { id: "s-1", userId: "u-1", expiresAt: new Date(Date.now() + 60_000) },
};

function makeApp(options: {
  checkDatabase: () => Promise<void>;
  resolveSession?: (headers: Headers) => Promise<SessionData | null>;
  authHandler?: (request: Request) => Promise<Response>;
}) {
  return createApp({
    logger,
    corsOrigins: ["http://localhost:5173"],
    checkDatabase: options.checkDatabase,
    authHandler:
      options.authHandler ??
      (() => Promise.reject(new Error("auth handler should not be called"))),
    resolveSession:
      options.resolveSession ??
      (() => {
        throw new Error("session should not be resolved");
      }),
  });
}

describe("health routes", () => {
  it("GET /health returns ok", async () => {
    const res = await makeApp({ checkDatabase: async () => {} }).request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("GET /ready returns 503 when the database is down", async () => {
    const res = await makeApp({ checkDatabase: () => Promise.reject(new Error("down")) }).request(
      "/ready",
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });
  });

  it("GET /ready returns 200 when the database responds", async () => {
    const res = await makeApp({ checkDatabase: async () => {} }).request("/ready");
    expect(res.status).toBe(200);
  });

  it("unknown routes return JSON 404", async () => {
    const res = await makeApp({ checkDatabase: async () => {} }).request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("session middleware (#22)", () => {
  it("rejects /api/* without a session with 401", async () => {
    const res = await makeApp({
      checkDatabase: async () => {},
      resolveSession: () => Promise.resolve(null),
    }).request("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("GET /api/me returns the current user from the session", async () => {
    const res = await makeApp({
      checkDatabase: async () => {},
      resolveSession: () => Promise.resolve(fakeSession),
    }).request("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: "u-1", email: "user@example.com", name: "User", emailVerified: true },
    });
  });

  it("auth endpoints bypass the session middleware and reach the auth handler", async () => {
    const seen: string[] = [];
    const res = await makeApp({
      checkDatabase: async () => {},
      resolveSession: () => {
        throw new Error("session must not be resolved on auth endpoints");
      },
      authHandler: (request) => {
        seen.push(new URL(request.url).pathname);
        return Promise.resolve(Response.json({ ok: true }));
      },
    }).request("/api/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toEqual(["/api/auth/sign-in/email"]);
  });


  it("non-api routes stay public (health does not need a session)", async () => {
    const res = await makeApp({
      checkDatabase: async () => {},
      resolveSession: () => {
        throw new Error("session must not be resolved on public routes");
      },
    }).request("/health");
    expect(res.status).toBe(200);
  });
});
