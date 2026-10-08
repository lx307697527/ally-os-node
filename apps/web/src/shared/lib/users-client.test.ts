// The team adapters' contracts, against a fake fetch — same discipline as
// numbering-client.test.ts: the read reports the failure mode instead of
// flattening it, every lifecycle verb speaks the kernel's specific rejection
// codes (owner_required, self_disable, owner_approval_*), every parse is
// zod, and the role word lists mirror the server registry without a second
// hand-copied drift point.
import { describe, expect, it, vi } from "vitest";

import {
  createUsersAdapters,
  INVITE_ROLES,
  STAFF_ROLES,
  type UserRow,
} from "./users-client.ts";

function fetchJson(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
}

const ROW: UserRow = {
  id: "u1",
  name: "Ann Owner",
  email: "ann@example.com",
  emailVerified: true,
  disabledAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  roles: ["owner"],
};

describe("team roster word lists (#26)", () => {
  it("STAFF_ROLES mirrors the approval editor's 14 staff roles; INVITE_ROLES excludes the R-16-6 three", () => {
    expect(STAFF_ROLES).toHaveLength(14);
    expect(STAFF_ROLES).not.toContain("customer");
    // 创建面的初始角色词表 = 14 员工角色 − owner/admin/finance;特权角色的
    // 唯一入口是花名册上走审批门的授予
    expect(INVITE_ROLES).toHaveLength(11);
    expect(INVITE_ROLES).not.toContain("owner");
    expect(INVITE_ROLES).not.toContain("admin");
    expect(INVITE_ROLES).not.toContain("finance");
    expect(INVITE_ROLES).toContain("sales");
  });
});

describe("team adapters (#26)", () => {
  it("list: parses the roster; 403 reads as forbidden, other failures as unavailable; status rides the query", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ users: [ROW], total: 1 }), { status: 200 })),
    );
    const ok = createUsersAdapters(fetcher);
    expect(await ok.list("disabled")).toEqual({ ok: true, data: { users: [ROW], total: 1 } });
    expect(fetcher).toHaveBeenCalledWith("/api/users?status=disabled", undefined);
    expect(await ok.list()).toEqual({ ok: true, data: { users: [ROW], total: 1 } });
    expect(fetcher).toHaveBeenLastCalledWith("/api/users", undefined);

    const forbidden = createUsersAdapters(fetchJson({}, 403));
    expect(await forbidden.list()).toEqual({ ok: false, reason: "forbidden" });

    const badShape = createUsersAdapters(fetchJson({ users: "everyone" }));
    expect(await badShape.list()).toEqual({ ok: false, reason: "unavailable" });

    const offline = createUsersAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.list()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("create: 201 parses the invite receipt; 409 exists, 403 forbidden, 400 invalid", async () => {
    let createBody = "";
    const fetcher: typeof fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body;
      if (typeof body === "string") createBody = body;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user: { id: "u2", email: "new@example.com", name: "New" },
            roles: ["sales"],
            inviteRequested: true,
          }),
          { status: 201 },
        ),
      );
    });
    const ok = createUsersAdapters(fetcher);
    const result = await ok.create({ email: "new@example.com", name: "New", roles: ["sales"] });
    expect(result).toEqual({
      ok: true,
      data: { user: { id: "u2", email: "new@example.com", name: "New" }, roles: ["sales"], inviteRequested: true },
    });
    expect(createBody).toBe(
      JSON.stringify({ email: "new@example.com", name: "New", roles: ["sales"] }),
    );

    const exists = createUsersAdapters(
      fetchJson({ error: "conflict", code: "user_exists", userId: "u2" }, 409),
    );
    expect(await exists.create({ email: "new@example.com" })).toEqual({ ok: false, reason: "exists" });

    const invalid = createUsersAdapters(fetchJson({ error: "invalid_request" }, 400));
    expect(await invalid.create({ email: "nope" })).toEqual({ ok: false, reason: "invalid" });

    const forbidden = createUsersAdapters(fetchJson({}, 403));
    expect(await forbidden.create({ email: "new@example.com" })).toEqual({ ok: false, reason: "forbidden" });
  });

  it("rename: 200 parses the row; 404/400/403 speak their own reasons", async () => {
    const ok = createUsersAdapters(fetchJson({ user: { id: "u1", name: "Renamed" } }, 200));
    expect(await ok.rename("u1", "Renamed")).toEqual({ ok: true, data: { id: "u1", name: "Renamed" } });

    const missing = createUsersAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await missing.rename("u1", "X")).toEqual({ ok: false, reason: "not_found" });

    const invalid = createUsersAdapters(fetchJson({ error: "invalid_request" }, 400));
    expect(await invalid.rename("u1", "")).toEqual({ ok: false, reason: "invalid" });

    const forbidden = createUsersAdapters(fetchJson({}, 403));
    expect(await forbidden.rename("u1", "X")).toEqual({ ok: false, reason: "forbidden" });
  });

  it("disable/enable: 200 ok; 403 splits owner_required from plain forbidden; 409 is the self refusal", async () => {
    const ok = createUsersAdapters(fetchJson({ disabled: true }, 200));
    expect(await ok.disable("u1")).toEqual({ ok: true });
    expect(await ok.enable("u1")).toEqual({ ok: true });

    const ownerRequired = createUsersAdapters(
      fetchJson({ error: "forbidden", code: "owner_required" }, 403),
    );
    expect(await ownerRequired.disable("u1")).toEqual({ ok: false, reason: "owner_required" });
    expect(await ownerRequired.enable("u1")).toEqual({ ok: false, reason: "owner_required" });

    const plainForbidden = createUsersAdapters(fetchJson({ error: "forbidden" }, 403));
    expect(await plainForbidden.disable("u1")).toEqual({ ok: false, reason: "forbidden" });

    const self = createUsersAdapters(fetchJson({ error: "conflict", code: "self_disable" }, 409));
    expect(await self.disable("u1")).toEqual({ ok: false, reason: "self" });

    const missing = createUsersAdapters(fetchJson({ error: "not_found" }, 404));
    expect(await missing.disable("u1")).toEqual({ ok: false, reason: "not_found" });

    const offline = createUsersAdapters(() => Promise.reject(new Error("offline")));
    expect(await offline.enable("u1")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("grant/revoke speak the R-16-6 outcomes: granted/revoked, 202 pending, 409 already pending, 403 approval required", async () => {
    const granted = createUsersAdapters(fetchJson({ role: "sales", granted: true }, 201));
    expect(await granted.grantRole("u1", "sales")).toEqual({ ok: true, outcome: "granted" });

    // 幂等结局按事实说话:本就持有 / 本就没有,不是成功动词的冒牌答案
    const alreadyHeld = createUsersAdapters(fetchJson({ role: "sales", granted: false }, 200));
    expect(await alreadyHeld.grantRole("u1", "sales")).toEqual({ ok: true, outcome: "already_held" });
    const alreadyAbsent = createUsersAdapters(fetchJson({ role: "sales", revoked: false }, 200));
    expect(await alreadyAbsent.revokeRole("u1", "sales")).toEqual({ ok: true, outcome: "already_absent" });

    const pending = createUsersAdapters(
      fetchJson({ approval: { requestId: "r9" } }, 202),
    );
    expect(await pending.grantRole("u1", "owner")).toEqual({ ok: true, outcome: "pending_approval" });

    const already = createUsersAdapters(
      fetchJson({ error: "conflict", code: "owner_approval_pending", requestId: "r9" }, 409),
    );
    expect(await already.grantRole("u1", "owner")).toEqual({ ok: false, reason: "owner_approval_pending" });

    const approvalRequired = createUsersAdapters(
      fetchJson({ error: "forbidden", code: "owner_approval_required" }, 403),
    );
    expect(await approvalRequired.grantRole("u1", "owner")).toEqual({
      ok: false,
      reason: "owner_approval_required",
    });
    expect(await approvalRequired.revokeRole("u1", "owner")).toEqual({
      ok: false,
      reason: "owner_approval_required",
    });

    const revoked = createUsersAdapters(fetchJson({ role: "sales", revoked: true }, 200));
    expect(await revoked.revokeRole("u1", "sales")).toEqual({ ok: true, outcome: "revoked" });

    const invalid = createUsersAdapters(fetchJson({ error: "invalid_request" }, 400));
    expect(await invalid.revokeRole("u1", "sales")).toEqual({ ok: false, reason: "invalid" });
  });
});
