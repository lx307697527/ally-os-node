// The team roster's data access (#26): the read (every account with its
// aggregated roles and disabled state) and the lifecycle writes (invite,
// rename, disable/enable) plus the role grant/revoke verbs that already
// existed server-side (#23). A primary admin surface, not a degrading
// widget — the adapter reports the failure mode instead of flattening it,
// so every refusal has a sentence. Response bodies are zod-parsed because
// API responses are external input as far as this bundle is concerned.
import { z } from "zod";

import { APPROVAL_ROLES } from "./approval-config-client.ts";

// The staff role word list — the same 14 non-customer roles the approval
// editor offers. The server's registry (apps/api authz/permissions.ts) is the
// source of truth; the alias keeps ONE list in this bundle rather than a
// second hand-copied one that could drift. users-client.test.ts pins it.
export const STAFF_ROLES = APPROVAL_ROLES;

// What an invitation may carry as INITIAL roles: staff roles minus the three
// the R-16-6 gate guards (owner, admin, finance). The create endpoint rejects
// those outright — the role checkboxes are born without them, so the refusal
// never fires from this page. Granting them later rides the roster's grant
// select, which does offer them (that is what the approval flow is for).
const PRIVILEGED_ASSIGNMENT_ROLES = ["owner", "admin", "finance"] as const;
export const INVITE_ROLES = APPROVAL_ROLES.filter(
  (role): role is Exclude<(typeof APPROVAL_ROLES)[number], (typeof PRIVILEGED_ASSIGNMENT_ROLES)[number]> =>
    !(PRIVILEGED_ASSIGNMENT_ROLES as readonly string[]).includes(role),
);

const userRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  disabledAt: z.string().nullable(),
  createdAt: z.string(),
  roles: z.array(z.string()),
});

const rosterSchema = z.object({ users: z.array(userRowSchema), total: z.number().int() });
const createdSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
  roles: z.array(z.string()),
  inviteRequested: z.boolean(),
});
const renamedSchema = z.object({ user: z.object({ id: z.string(), name: z.string() }) });
const lifecycleSchema = z.object({ disabled: z.boolean() });
const grantedSchema = z.object({ role: z.string(), granted: z.boolean() });
const revokedSchema = z.object({ role: z.string(), revoked: z.boolean() });

export type UserRow = z.infer<typeof userRowSchema>;
export type RosterStatus = "active" | "disabled";

export type ReadFailure = "forbidden" | "unavailable";

export type CreateFailure =
  | "forbidden"
  | "invalid"
  | "exists"
  | "unavailable";
export type RenameFailure = "forbidden" | "not_found" | "invalid" | "unavailable";
export type LifecycleFailure =
  | "forbidden"
  | "owner_required"
  | "self"
  | "not_found"
  | "unavailable";
export type RoleChangeFailure =
  | "forbidden"
  | "owner_approval_required"
  | "owner_approval_pending"
  | "not_found"
  | "invalid"
  | "unavailable";

export interface CreateInput {
  email: string;
  name?: string;
  roles?: string[];
}

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; code: string | null }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      // 机器错误码（409 self_disable / 403 owner_required / …）：页面按它分句
      code:
        typeof raw === "object" && raw !== null && "code" in raw
          ? String(raw.code)
          : null,
    };
  } catch {
    return { status: 0, body: null, code: null };
  }
}

export interface UsersAdapters {
  list(
    status?: RosterStatus,
  ): Promise<{ ok: true; data: { users: UserRow[]; total: number } } | { ok: false; reason: ReadFailure }>;
  create(
    input: CreateInput,
  ): Promise<
    | { ok: true; data: { user: { id: string; email: string; name: string }; roles: string[]; inviteRequested: boolean } }
    | { ok: false; reason: CreateFailure }
  >;
  rename(
    userId: string,
    name: string,
  ): Promise<{ ok: true; data: { id: string; name: string } } | { ok: false; reason: RenameFailure }>;
  disable(userId: string): Promise<{ ok: true } | { ok: false; reason: LifecycleFailure }>;
  enable(userId: string): Promise<{ ok: true } | { ok: false; reason: LifecycleFailure }>;
  grantRole(
    userId: string,
    role: string,
  ): Promise<
    | { ok: true; outcome: "granted" | "already_held" | "pending_approval" }
    | { ok: false; reason: RoleChangeFailure }
  >;
  revokeRole(
    userId: string,
    role: string,
  ): Promise<
    | { ok: true; outcome: "revoked" | "already_absent" }
    | { ok: false; reason: RoleChangeFailure }
  >;
}

export function createUsersAdapters(fetchFn: typeof fetch = fetch): UsersAdapters {
  return {
    async list(status) {
      const query = status === undefined ? "" : `?status=${status}`;
      const res = await readJson(fetchFn, rosterSchema, `/api/users${query}`);
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body };
    },

    async create(input) {
      const res = await readJson(fetchFn, createdSchema, "/api/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 409) return { ok: false as const, reason: "exists" as const };
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async rename(userId, name) {
      const res = await readJson(fetchFn, renamedSchema, `/api/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: { id: res.body.user.id, name: res.body.user.name } };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async disable(userId) {
      return lifecycle(fetchFn, userId, "disable");
    },

    async enable(userId) {
      return lifecycle(fetchFn, userId, "enable");
    },

    async grantRole(userId, role) {
      const res = await readJson(fetchFn, grantedSchema, `/api/users/${encodeURIComponent(userId)}/roles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      // 202 = 进了 R-16-6 审批线;200 granted:false = 本就持有(页面的下拉
      // 不列已持有的角色,这个结局来自并发授予,按事实说话)
      if (res.status === 202) return { ok: true as const, outcome: "pending_approval" as const };
      if ((res.status === 200 || res.status === 201) && res.body !== null) {
        return { ok: true as const, outcome: res.body.granted ? ("granted" as const) : ("already_held" as const) };
      }
      return { ok: false as const, reason: roleChangeFailure(res) };
    },

    async revokeRole(userId, role) {
      const res = await readJson(
        fetchFn,
        revokedSchema,
        `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`,
        { method: "DELETE" },
      );
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, outcome: res.body.revoked ? ("revoked" as const) : ("already_absent" as const) };
      }
      return { ok: false as const, reason: roleChangeFailure(res) };
    },
  };
}

async function lifecycle(
  fetchFn: typeof fetch,
  userId: string,
  verb: "disable" | "enable",
): Promise<{ ok: true } | { ok: false; reason: LifecycleFailure }> {
  const res = await readJson(fetchFn, lifecycleSchema, `/api/users/${encodeURIComponent(userId)}/${verb}`, {
    method: "POST",
  });
  if (res.status === 403) {
    return {
      ok: false as const,
      reason: res.code === "owner_required" ? ("owner_required" as const) : ("forbidden" as const),
    };
  }
  if (res.status === 409) {
    return { ok: false as const, reason: "self" as const };
  }
  if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
  if (res.status === 200) return { ok: true as const };
  return { ok: false as const, reason: "unavailable" as const };
}

function roleChangeFailure(res: { status: number; code: string | null }): RoleChangeFailure {
  if (res.status === 403) {
    return res.code === "owner_approval_required" ? "owner_approval_required" : "forbidden";
  }
  if (res.status === 409) return "owner_approval_pending";
  if (res.status === 404) return "not_found";
  return res.status === 400 ? "invalid" : "unavailable";
}
