// The approval lines' data access (#221 config face): the config reads and
// writes (list, create, in-place update) plus the #226 ledger reads and
// rollback, and the staff directory that backs the per-level user picker.
//
// Like the other config studios, the adapter reports the failure mode instead
// of flattening it — "why is the table empty" always has an answer in words:
//
//   { ok: true, data }                        — the call worked
//   { ok: false, reason: "forbidden" }        — 403: no approval.configure
//   { ok: false, reason: "unavailable" }      — network/5xx/unparseable body
// and the writes add the kernel's specific rejections: a bad levels shape
// (422 invalid_levels, with the server's per-level detail), a taken key
// (409), a line that no longer exists (404). Response bodies are zod-parsed
// because API responses are external input as far as this bundle is
// concerned.
import { z } from "zod";

// Mirrors ROLES in apps/api/src/authz/permissions.ts — the server enum is the
// source of truth; this copy is what the level editor's role checkboxes offer
// and what the row parse accepts. customer is part of the enum (a valid role
// word) but the server refuses it as an approver, so the editor never offers
// it. approval-config-client.test.ts pins the mirror against the rendering
// rules.
export const APPROVAL_ROLES = [
  "owner",
  "admin",
  "sales_lead",
  "sales",
  "customer_service",
  "sales_assistant",
  "ops_assistant",
  "formulator",
  "purchaser",
  "warehouse",
  "production_lead",
  "qa",
  "lab_technician",
  "finance",
] as const;
export type ApprovalRole = (typeof APPROVAL_ROLES)[number];

// Mirrors the mode enum in apps/api/src/approval/service.ts approvalLevelsSchema.
export const APPROVAL_LEVEL_MODES = ["any", "all", "quorum"] as const;
export type ApprovalLevelMode = (typeof APPROVAL_LEVEL_MODES)[number];

// Mirrors the esign meanings the kernel accepts for approval levels (#219).
export const APPROVAL_SIGNATURE_MEANINGS = ["reviewed", "approved"] as const;
export type ApprovalSignatureMeaning = (typeof APPROVAL_SIGNATURE_MEANINGS)[number];

const levelSchema = z.object({
  name: z.string(),
  users: z.array(z.string()),
  roles: z.array(z.string()),
  mode: z.enum(APPROVAL_LEVEL_MODES),
  quorum: z.number().int().optional(),
  requireSignature: z.boolean(),
  signatureMeaning: z.enum(APPROVAL_SIGNATURE_MEANINGS),
});

const configRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  configKey: z.string(),
  name: z.string(),
  levels: z.array(levelSchema),
  active: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.string(),
});

const configsPageSchema = z.object({ configs: z.array(configRowSchema) });
const createdSchema = z.object({ id: z.string() });
const updatedSchema = z.object({ config: configRowSchema });

const revisionSchema = z.object({
  version: z.number().int().min(1),
  source: z.string(),
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })).nullable(),
  changedById: z.string().nullable(),
  createdAt: z.string(),
});
const revisionsPageSchema = z.object({
  revisions: z.array(revisionSchema),
});
const rollbackResponseSchema = z.object({
  subjectType: z.string(),
  subjectId: z.string(),
  restoredVersion: z.number().int().min(1),
  newVersion: z.number().int().min(1),
});

const directorySchema = z.object({
  assignees: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
});

export type ApprovalConfigRow = z.infer<typeof configRowSchema>;
export type ApprovalLevel = z.infer<typeof levelSchema>;
export type ApprovalRevision = z.infer<typeof revisionSchema>;
export type StaffOption = z.infer<(typeof directorySchema)["shape"]["assignees"]["element"]>;

export type ApprovalReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export type CreateConfigFailure =
  | "forbidden"
  | "exists"
  | "invalid_levels"
  | "invalid"
  | "unavailable";
export type UpdateConfigFailure =
  | "forbidden"
  | "not_found"
  | "invalid_levels"
  | "invalid"
  | "unavailable";
export type RollbackFailure =
  | "forbidden"
  | "not_found"
  | "no_change"
  | "unsupported"
  | "unavailable";

export interface CreateConfigInput {
  subjectType: string;
  configKey: string;
  name: string;
  levels: ApprovalLevel[];
}

// The key is identity and never changes; an update rewrites the definition
// (name/levels/active) in place under a new ledger version.
export interface UpdateConfigInput {
  name?: string;
  levels?: ApprovalLevel[];
  active?: boolean;
}

export const APPROVAL_CONFIG_SUBJECT = "approval_config";

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; error: string | null }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      error:
        typeof raw === "object" && raw !== null && "error" in raw
          ? String(raw.error)
          : null,
    };
  } catch {
    return { status: 0, body: null, error: null };
  }
}

export interface ApprovalConfigAdapters {
  list(): Promise<ApprovalReadResult<ApprovalConfigRow[]>>;
  directory(): Promise<ApprovalReadResult<StaffOption[]>>;
  create(
    input: CreateConfigInput,
  ): Promise<{ ok: true; data: { id: string } } | { ok: false; reason: CreateConfigFailure }>;
  update(
    id: string,
    input: UpdateConfigInput,
  ): Promise<
    | { ok: true; data: ApprovalConfigRow }
    | { ok: false; reason: UpdateConfigFailure }
  >;
  history(subjectId: string): Promise<ApprovalReadResult<ApprovalRevision[]>>;
  rollback(
    subjectId: string,
    toVersion: number,
    reason?: string,
  ): Promise<
    | { ok: true; data: z.infer<typeof rollbackResponseSchema> }
    | { ok: false; reason: RollbackFailure }
  >;
}

export function createApprovalConfigAdapters(fetchFn: typeof fetch = fetch): ApprovalConfigAdapters {
  return {
    async list() {
      const res = await readJson(fetchFn, configsPageSchema, "/api/approval-configs");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.configs };
    },

    async directory() {
      // The staff picker reads the tasks assignee directory (session face) —
      // the same non-customer staff list assignee pickers use elsewhere.
      const res = await readJson(fetchFn, directorySchema, "/api/tasks/assignee-options");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.assignees };
    },

    async create(input) {
      const res = await readJson(fetchFn, createdSchema, "/api/approval-configs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 409) return { ok: false as const, reason: "exists" as const };
      if (res.status === 422) return { ok: false as const, reason: "invalid_levels" as const };
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async update(id, input) {
      const res = await readJson(fetchFn, updatedSchema, `/api/approval-configs/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 422) return { ok: false as const, reason: "invalid_levels" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body.config };
      }
      return { ok: false as const, reason: res.status === 400 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async history(subjectId) {
      const res = await readJson(
        fetchFn,
        revisionsPageSchema,
        `/api/config-versions/${APPROVAL_CONFIG_SUBJECT}/${encodeURIComponent(subjectId)}`,
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.revisions };
    },

    async rollback(subjectId, toVersion, reason) {
      const res = await readJson(
        fetchFn,
        rollbackResponseSchema,
        `/api/config-versions/${APPROVAL_CONFIG_SUBJECT}/${encodeURIComponent(subjectId)}/rollback`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reason !== undefined && reason !== "" ? { toVersion, reason } : { toVersion }),
        },
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 409 && res.error === "rollback_no_change") {
        return { ok: false as const, reason: "no_change" as const };
      }
      if (res.status === 409 && res.error === "rollback_unsupported") {
        return { ok: false as const, reason: "unsupported" as const };
      }
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: "unavailable" as const };
    },
  };
}
