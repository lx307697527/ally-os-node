import type { Db } from "@ally/db";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { SessionData } from "./auth/session.ts";
import type { Permission, Role } from "./authz/permissions.ts";
import type { AuthzStore } from "./authz/service.ts";

/**
 * 这些用例只打 health / auth-providers / 会话中间件 / me，不触达角色管理路由；
 * db 不会被真正调用，抛错的哑对象仅为满足依赖注入签名。
 */
const unusedDb = {
  get dummy(): never {
    throw new Error("db must not be touched by these tests");
  },
} as unknown as Db;

const logger = pino({ level: "silent" });

const fakeSession: SessionData = {
  user: { id: "u-1", email: "user@example.com", name: "User", emailVerified: true, twoFactorEnabled: true },
  session: { id: "s-1", userId: "u-1", expiresAt: new Date(Date.now() + 60_000) },
};

/** 内存版授权存根：按 userId 记住角色；权限点全部走角色默认集 */
function memoryStore(seed: Record<string, Role[]> = {}): AuthzStore {
  const roles: Record<string, Role[]> = { ...seed };
  return {
    async getRoles(userId) {
      await Promise.resolve();
      return roles[userId] ?? [];
    },
    async getDirectPermissions(): Promise<Permission[]> {
      await Promise.resolve();
      return [];
    },
    async grantRole(userId, role) {
      await Promise.resolve();
      const held = roles[userId] ?? [];
      if (held.includes(role)) return false;
      roles[userId] = [...held, role];
      return true;
    },
    async revokeRole(userId, role) {
      await Promise.resolve();
      const held = roles[userId] ?? [];
      if (!held.includes(role)) return false;
      roles[userId] = held.filter((r) => r !== role);
      return true;
    },
  };
}

function makeApp(options: {
  checkDatabase: () => Promise<void>;
  resolveSession?: (headers: Headers) => Promise<SessionData | null>;
  authHandler?: (request: Request) => Promise<Response>;
  socialProviders?: readonly string[];
  authzStore?: AuthzStore;
}) {
  return createApp({
    stripe: undefined,
    sendPasswordSetupEmail: async () => {},
    paypal: undefined,
    logger,
    db: unusedDb,
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
    socialProviders: options.socialProviders ?? [],
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
      head: () => Promise.reject(new Error("storage not used in this suite")),
    },
    authzStore: options.authzStore ?? memoryStore(),
  
    notifyUsers: async () => {},});
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
      authzStore: memoryStore({ "u-1": ["admin"] }),
    }).request("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id: "u-1", email: "user@example.com", name: "User", emailVerified: true, twoFactorEnabled: true },
      authz: { roles: ["admin"], permissions: ["roles.assign", "users.manage", "audit.read", "workflow.configure", "approval.configure", "custom_fields.configure", "automations.configure", "numbering.configure", "rules.configure", "templates.configure", "feedback.manage"] },
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

describe("auth providers route (#22 slice 4)", () => {
  it("lists the enabled social providers, without a session", async () => {
    const res = await makeApp({
      checkDatabase: async () => {},
      resolveSession: () => {
        throw new Error("session must not be resolved on the providers route");
      },
      socialProviders: ["google"],
    }).request("/api/auth-providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: ["google"] });
  });

  it("answers an empty list on a password-only deployment — the SPA renders no button", async () => {
    const res = await makeApp({
      checkDatabase: async () => {},
      resolveSession: () => {
        throw new Error("session must not be resolved on the providers route");
      },
    }).request("/api/auth-providers");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });
});
