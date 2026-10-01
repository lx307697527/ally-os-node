import pino from "pino";
import { describe, expect, it } from "vitest";
import { parseEnv, type Env } from "@ally/config";
import { createRealtimeAuthenticator } from "./auth.ts";

const logger = pino({ level: "silent" });

function makeEnv(nodeEnv: "development" | "production"): Env {
  return parseEnv({
    NODE_ENV: nodeEnv,
    DATABASE_URL: "postgres://ally:ally@localhost:5432/ally",
    S3_BUCKET: "ally",
    BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
  });
}

/** 假的会话校验器：只认 "live-session" 这一个令牌 */
const fakeVerifier = (token: string) =>
  token === "live-session"
    ? Promise.resolve({ userId: "u-1" })
    : Promise.resolve(null);

describe("createRealtimeAuthenticator", () => {
  it("accepts dev:<userId> tokens outside production", async () => {
    const authenticate = createRealtimeAuthenticator(makeEnv("development"), logger);
    expect(await authenticate("dev:alice")).toEqual({ userId: "alice" });
    expect(await authenticate("dev:")).toBeNull();
  });

  it("rejects everything in production when no session verifier is wired", async () => {
    const authenticate = createRealtimeAuthenticator(makeEnv("production"), logger);
    expect(await authenticate("dev:alice")).toBeNull();
    expect(await authenticate("anything")).toBeNull();
  });

  it("validates session tokens through the injected verifier", async () => {
    const authenticate = createRealtimeAuthenticator(
      makeEnv("production"),
      logger,
      fakeVerifier,
    );
    expect(await authenticate("live-session")).toEqual({ userId: "u-1" });
    expect(await authenticate("live-session.stale-signature")).toBeNull();
    expect(await authenticate("")).toBeNull();
  });

  it("never accepts dev: tokens in production, even with a verifier wired", async () => {
    const authenticate = createRealtimeAuthenticator(
      makeEnv("production"),
      logger,
      fakeVerifier,
    );
    expect(await authenticate("dev:alice")).toBeNull();
  });

  it("outside production, unknown tokens still fall through to the verifier", async () => {
    const authenticate = createRealtimeAuthenticator(makeEnv("development"), logger, fakeVerifier);
    expect(await authenticate("live-session")).toEqual({ userId: "u-1" });
    expect(await authenticate("unknown")).toBeNull();
  });
});
