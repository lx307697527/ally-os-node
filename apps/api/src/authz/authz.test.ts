import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AppEnv, SessionData } from "../auth/session.ts";
import { authzMiddleware, requirePermission, requireRole } from "./middleware.ts";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  effectivePermissions,
  type Permission,
  type Role,
} from "./permissions.ts";
import type { AuthzStore } from "./service.ts";

const logger = pino({ level: "silent" });

const session: SessionData = {
  user: { id: "u-1", email: "user@example.com", name: "User", emailVerified: true, twoFactorEnabled: true },
  session: { id: "s-1", userId: "u-1", expiresAt: new Date(Date.now() + 60_000) },
};

/** 会话桩：等价于生产里 sessionMiddleware 之后的 context 状态 */
const setSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", session.user);
  c.set("session", session.session);
  await next();
};

/** 探针门：只放行注册表里的权限点（成员检查过才收窄），挂法与业务路由一致 */
const requireRegisteredPermission: MiddlewareHandler<AppEnv> = async (c, next) => {
  const name = c.req.param("permission");
  if (!PERMISSIONS.includes(name as Permission)) {
    return c.json({ error: "forbidden", code: "permission_required" }, 403);
  }
  return requirePermission(name as Permission)(c, next);
};

describe("permission registry (#23)", () => {
  it("every role has a matrix row, and every referenced permission is registered", () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...ROLES].sort());
    for (const role of ROLES) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });

  it("label_design is carried by no role by default (grantable per person only)", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("label_design");
    }
  });

  it("effectivePermissions unions role defaults with direct grants", () => {
    expect(effectivePermissions(["admin"], [])).toEqual(
      new Set<Permission>([
        "roles.assign",
        "users.manage",
        "audit.read",
        "workflow.configure",
        "approval.configure",
        "custom_fields.configure",
        "automations.configure",
        "numbering.configure",
        "rules.configure",
        "templates.configure",
        "feedback.manage",
      ]),
    );
    expect(effectivePermissions([], ["label_design"])).toEqual(
      new Set<Permission>(["label_design"]),
    );
    expect(effectivePermissions(["sales"], ["label_design"])).toEqual(
      new Set<Permission>(["label_design"]),
    );
  });
});

describe("authz middleware (#23)", () => {
  function storeWith(roles: Role[], direct: Permission[]): AuthzStore {
    return {
      getRoles: () => Promise.resolve(roles),
      getDirectPermissions: () => Promise.resolve(direct),
      grantRole: () => Promise.resolve(true),
      revokeRole: () => Promise.resolve(false),
    };
  }

  /** 最小挂载环境：会话桩 + authzMiddleware + 两条探针路由（挂法与 app.ts 同款） */
  function harness(store: AuthzStore) {
    const app = new Hono<AppEnv>();
    app.use("*", setSession);
    app.use("*", authzMiddleware(store));
    app.get("/probe/role", requireRole("admin", "owner"), (c) => c.json({ ok: true }));
    app.get("/probe/permission/:permission", requireRegisteredPermission, (c) =>
      c.json({ ok: true }),
    );
    return app;
  }

  it("requireRole passes when ANY listed role is held (has_any_role semantics)", async () => {
    const res = await harness(storeWith(["sales"], [])).request("/probe/role");
    expect(res.status).toBe(403);
    const ok = await harness(storeWith(["customer", "admin"], [])).request("/probe/role");
    expect(ok.status).toBe(200);
  });

  it("requireRole answers 403 role_required with the required set", async () => {
    const res = await harness(storeWith([], [])).request("/probe/role");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      code: "role_required",
      required: ["admin", "owner"],
    });
  });

  // 权限矩阵即测试：注册表里每个（角色 × 权限点）组合，能过/不能过必须与
  // ROLE_PERMISSIONS 一致——新权限点加进注册表的那一刻自动进入这条断言。
  it("matrix: every role x permission combination matches ROLE_PERMISSIONS", async () => {
    for (const role of ROLES) {
      const probe = harness(storeWith([role], []));
      for (const permission of PERMISSIONS) {
        const res = await probe.request(`/probe/permission/${permission}`);
        const expected = ROLE_PERMISSIONS[role].includes(permission) ? 200 : 403;
        expect([role, permission, res.status]).toEqual([role, permission, expected]);
      }
    }
  });

  it("direct per-person grants work without any role (label design external designer)", async () => {
    const probe = harness(storeWith([], ["label_design"]));
    const ok = await probe.request("/probe/permission/label_design");
    expect(ok.status).toBe(200);
    const no = await probe.request("/probe/permission/roles.assign");
    expect(no.status).toBe(403);
  });

  it("requirePermission answers 403 permission_required naming the permission", async () => {
    const res = await harness(storeWith([], [])).request("/probe/permission/roles.assign");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "forbidden",
      code: "permission_required",
      permission: "roles.assign",
    });
  });

  it("store failures surface as 500 without internal details", async () => {
    const failing: AuthzStore = {
      getRoles: () => Promise.reject(new Error("db down")),
      getDirectPermissions: () => Promise.resolve([]),
      grantRole: () => Promise.resolve(true),
      revokeRole: () => Promise.resolve(false),
    };
    const app = new Hono<AppEnv>();
    app.onError((err, c) => {
      logger.error({ err }, "unhandled error");
      return c.json({ error: "internal_error" }, 500);
    });
    app.use("*", setSession);
    app.use("*", authzMiddleware(failing));
    app.get("/probe", (c) => c.json({ ok: true }));
    const res = await app.request("/probe");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
