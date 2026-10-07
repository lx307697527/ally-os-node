import type { Db } from "@ally/db";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import { PERMISSIONS, type Permission, type Role } from "../authz/permissions.ts";
import type { AuthzStore } from "../authz/service.ts";
import { API_ROUTES } from "./registry.ts";

/** 本文件只做路由表比对，不打任何业务路由；db 哑对象仅为满足注入签名 */
const unusedDb = {
  get dummy(): never {
    throw new Error("db must not be touched by these tests");
  },
} as unknown as Db;

/**
 * #23 验收第 2 条：「每个 API 路由都有授权声明，缺失时 lint / 测试会报错」。
 * 这里把 app 实际注册的路由（app.routes）与 routes/registry.ts 的声明清单做
 * 双向比对：新路由不写声明 → 红；声明指向已删除的路由 → 红。公开路由的集合
 * 也钉死——任何新公开端点都必须显式更新这份测试，不能悄悄溜进来。
 */
const logger = pino({ level: "silent" });

const memoryStore: AuthzStore = {
  getRoles: () => Promise.resolve<Role[]>([]),
  getDirectPermissions: () => Promise.resolve<Permission[]>([]),
  grantRole: () => Promise.resolve(true),
  revokeRole: () => Promise.resolve(false),
};

const app = createApp({
    stripe: undefined,
    paypal: undefined,
    logger,
  db: unusedDb,
  corsOrigins: [],
  checkDatabase: async () => {},
  authHandler: () => Promise.resolve(Response.json({ ok: true })),
  resolveSession: () => Promise.resolve(null),
  socialProviders: [],
    // 本套件不 exercise 附件端点；真被调到会在这里大声炸（AppDeps.storage 必选）
    storage: {
      put: () => Promise.reject(new Error("storage not used in this suite")),
      signedGetUrl: () => Promise.reject(new Error("storage not used in this suite")),
      signedPutUrl: () => Promise.reject(new Error("storage not used in this suite")),
      delete: () => Promise.reject(new Error("storage not used in this suite")),
    },
  authzStore: memoryStore,

    notifyUsers: async () => {},});

/**
 * app.routes 的 (method, path) 对；方法统一大写。method 为 "ALL" 的是 app.use
 * 挂的中间件（session/authz 的 /api/* 通配），不是端点，排除——声明清单只登记端点。
 */
function registeredRoutes(): { method: string; path: string }[] {
  return app.routes
    .map((route) => ({ method: route.method.toUpperCase(), path: route.path }))
    .filter((route) => route.method !== "ALL");
}

function declMatches(
  decl: { method: string; path: string },
  route: { method: string; path: string },
): boolean {
  return decl.path === route.path && (decl.method === "*" || decl.method === route.method);
}

describe("route authorization declarations (#23)", () => {
  it("every /api/* route registered on the app has a declaration", () => {
    const undeclared = registeredRoutes()
      .filter((route) => route.path.startsWith("/api/"))
      .filter((route) => !API_ROUTES.some((decl) => declMatches(decl, route)));
    expect(undeclared).toEqual([]);
  });

  it("every declaration points at a registered route (no stale entries)", () => {
    const routes = registeredRoutes();
    const stale = API_ROUTES.filter((decl) => !routes.some((route) => declMatches(decl, route)));
    expect(stale).toEqual([]);
  });

  it("public routes are exactly the pinned allowlist (no new public endpoint slips in)", () => {
    const publicPaths = API_ROUTES.filter((decl) => decl.auth.kind === "public").map(
      (decl) => decl.path,
    );
    // /api/webhooks/stripe（#193）：公开指「不过会话中间件」，认证是 Stripe 签名
    // 本身（routes/stripe-webhook.ts）；/api/webhooks/paypal 同理，认证是
    // verify-webhook-signature 活体验签（routes/paypal-webhook.ts）；漏登记才是
    // 真的口子
    expect(publicPaths.sort()).toEqual(
      ["/api/auth-providers", "/api/auth/*", "/api/webhooks/stripe", "/api/webhooks/paypal"].sort(),
    );
  });

  it("permission-guarded routes in the registry have their permission registered", () => {
    for (const decl of API_ROUTES) {
      if (decl.auth.kind === "permission") {
        expect([...PERMISSIONS]).toContain(decl.auth.permission);
      }
    }
  });
});
