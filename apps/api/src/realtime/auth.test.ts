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
  });
}

describe("createRealtimeAuthenticator", () => {
  it("accepts dev:<userId> tokens outside production", async () => {
    const authenticate = createRealtimeAuthenticator(makeEnv("development"), logger);
    expect(await authenticate("dev:alice")).toEqual({ userId: "alice" });
    expect(await authenticate("dev:")).toBeNull();
    expect(await authenticate("session-abc")).toBeNull();
  });

  it("rejects everything in production until #22 wires the real authenticator", async () => {
    const authenticate = createRealtimeAuthenticator(makeEnv("production"), logger);
    expect(await authenticate("dev:alice")).toBeNull();
    expect(await authenticate("anything")).toBeNull();
  });
});
