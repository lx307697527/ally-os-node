// The custom fields' data access (#222 config face): the field-definition
// reads and writes (list, create, in-place update) plus the #226 ledger reads
// and rollback.
//
// Like the other config studios, the adapter reports the failure mode instead
// of flattening it — "why is the table empty" always has an answer in words:
//
//   { ok: true, data }                        — the call worked
//   { ok: false, reason: "forbidden" }        — 403: no custom_fields.configure
//   { ok: false, reason: "unavailable" }      — network/5xx/unparseable body
// and the writes add the kernel's specific rejections: a taken key (409), a
// select-options rule violation (422 invalid_options), a definition that no
// longer exists (404). Response bodies are zod-parsed because API responses
// are external input as far as this bundle is concerned.
import { z } from "zod";

// Mirrors CUSTOM_FIELD_TYPES in apps/api/src/custom-fields/service.ts — the
// server enum is the source of truth; this copy is what the type pickers offer
// and what the row parse accepts.
export const FIELD_TYPES = ["text", "number", "boolean", "date", "select"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

// Mirrors ROLES in apps/api/src/authz/permissions.ts — including customer:
// unlike approvers, a field may legitimately be visible to (or even editable
// by) the customer. custom-fields-client.test.ts pins the mirror.
export const FIELD_ROLES = [
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
  "customer",
] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];

export const CUSTOM_FIELD_DEF_SUBJECT = "custom_field_def";

const fieldRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  fieldKey: z.string(),
  label: z.string(),
  fieldType: z.enum(FIELD_TYPES),
  options: z.array(z.string()).nullable(),
  required: z.boolean(),
  viewableBy: z.array(z.string()),
  editableBy: z.array(z.string()),
  active: z.boolean(),
  version: z.number().int().min(1),
  createdAt: z.string(),
});

const fieldsPageSchema = z.object({ fields: z.array(fieldRowSchema) });
const createdSchema = z.object({ id: z.string() });
const updatedSchema = z.object({ field: fieldRowSchema });

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

export type CustomFieldRow = z.infer<typeof fieldRowSchema>;
export type CustomFieldRevision = z.infer<typeof revisionSchema>;

export type CustomFieldReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export type CreateFieldFailure =
  | "forbidden"
  | "exists"
  | "invalid_options"
  | "invalid"
  | "unavailable";
export type UpdateFieldFailure =
  | "forbidden"
  | "not_found"
  | "invalid_options"
  | "invalid"
  | "unavailable";
export type RollbackFailure =
  | "forbidden"
  | "not_found"
  | "no_change"
  | "unsupported"
  | "unavailable";

export interface CreateFieldInput {
  subjectType: string;
  fieldKey: string;
  label: string;
  fieldType: FieldType;
  options?: string[];
  required: boolean;
  viewableBy: FieldRole[];
  editableBy: FieldRole[];
}

// The subject type and the key are identity and never change; an update
// rewrites the definition (label/type/options/required/roles/active) in place
// under a new ledger version. Existing values keep the JSON they were written
// with — a type change never rewrites them.
export interface UpdateFieldInput {
  label?: string;
  fieldType?: FieldType;
  options?: string[] | null;
  required?: boolean;
  viewableBy?: FieldRole[];
  editableBy?: FieldRole[];
  active?: boolean;
}

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

export interface CustomFieldsAdapters {
  list(subjectType?: string): Promise<CustomFieldReadResult<CustomFieldRow[]>>;
  create(
    input: CreateFieldInput,
  ): Promise<{ ok: true; data: { id: string } } | { ok: false; reason: CreateFieldFailure }>;
  update(
    id: string,
    input: UpdateFieldInput,
  ): Promise<
    | { ok: true; data: CustomFieldRow }
    | { ok: false; reason: UpdateFieldFailure }
  >;
  history(subjectId: string): Promise<CustomFieldReadResult<CustomFieldRevision[]>>;
  rollback(
    subjectId: string,
    toVersion: number,
    reason?: string,
  ): Promise<
    | { ok: true; data: z.infer<typeof rollbackResponseSchema> }
    | { ok: false; reason: RollbackFailure }
  >;
}

export function createCustomFieldsAdapters(fetchFn: typeof fetch = fetch): CustomFieldsAdapters {
  return {
    async list(subjectType) {
      const query = subjectType !== undefined && subjectType !== ""
        ? `?subjectType=${encodeURIComponent(subjectType)}`
        : "";
      const res = await readJson(fetchFn, fieldsPageSchema, `/api/custom-fields${query}`);
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.fields };
    },

    async create(input) {
      const res = await readJson(fetchFn, createdSchema, "/api/custom-fields", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 409) return { ok: false as const, reason: "exists" as const };
      if (res.status === 422 && res.error === "invalid_options") {
        return { ok: false as const, reason: "invalid_options" as const };
      }
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      return { ok: false as const, reason: res.status === 422 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async update(id, input) {
      const res = await readJson(fetchFn, updatedSchema, `/api/custom-fields/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 422 && res.error === "invalid_options") {
        return { ok: false as const, reason: "invalid_options" as const };
      }
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body.field };
      }
      return { ok: false as const, reason: res.status === 422 ? ("invalid" as const) : ("unavailable" as const) };
    },

    async history(subjectId) {
      const res = await readJson(
        fetchFn,
        revisionsPageSchema,
        `/api/config-versions/${CUSTOM_FIELD_DEF_SUBJECT}/${encodeURIComponent(subjectId)}`,
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
        `/api/config-versions/${CUSTOM_FIELD_DEF_SUBJECT}/${encodeURIComponent(subjectId)}/rollback`,
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
