// The workflow templates' data access (#220 config face): the read (the
// template list — the page's single source, rows carry the definition) and
// the two writes (create, update). A config page is a primary surface, not a
// degrading widget — like the numbering page, the adapter reports the failure
// mode instead of flattening it, so "why is the list empty" always has an
// answer in words.
//
//   { ok: true, data }                        — the call worked
//   { ok: false, reason: "forbidden" }        — 403: no workflow.configure
//   { ok: false, reason: "unavailable" }      — network/5xx/unparseable body
// and the writes add the specific rejections the kernel speaks: a key
// collision, a default-template collision (409), a definition the four save
// gates refused (422, with the engine's detail), a missing template.
// Response bodies are zod-parsed because API responses are external input as
// far as this bundle is concerned. The `definition` field passes through as
// unknown — rendering goes through workflow-diagram.ts, never raw.
import { z } from "zod";

const templateRowSchema = z.object({
  id: z.string(),
  subjectType: z.string(),
  templateKey: z.string(),
  productType: z.string().nullable(),
  isDefault: z.boolean(),
  active: z.boolean(),
  definition: z.unknown(),
  version: z.number().int().min(1),
  createdAt: z.string(),
});

const templatesPageSchema = z.object({ templates: z.array(templateRowSchema) });
const createdSchema = z.object({ id: z.string() });
const updatedSchema = z.object({ template: templateRowSchema });

export type WorkflowTemplateRow = z.infer<typeof templateRowSchema>;

export type WorkflowReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "forbidden" | "unavailable" };

export type CreateTemplateFailure =
  | "forbidden"
  | "exists"
  | "default_exists"
  | "unavailable";
export type UpdateTemplateFailure =
  | "forbidden"
  | "not_found"
  | "default_exists"
  | "unavailable";
/** A 422 from the definition save gates carries the engine's detail text. */
export interface InvalidTemplate {
  ok: false;
  reason: "invalid";
  detail: string | null;
}

export type CreateTemplateResult =
  | { ok: true; data: { id: string } }
  | InvalidTemplate
  | { ok: false; reason: CreateTemplateFailure };

export type UpdateTemplateResult =
  | { ok: true; data: WorkflowTemplateRow }
  | InvalidTemplate
  | { ok: false; reason: UpdateTemplateFailure };

// templateKey/subjectType are identity, not content — the server's strict
// PATCH refuses them; the client's update type simply has no such fields.
export interface UpdateTemplateInput {
  productType?: string | null;
  isDefault?: boolean;
  active?: boolean;
  definition?: unknown;
}

export interface CreateTemplateInput {
  subjectType: string;
  templateKey: string;
  productType: string | null;
  isDefault: boolean;
  definition: unknown;
}

async function readJson<T>(
  fetchFn: typeof fetch,
  schema: z.ZodType<T>,
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: T | null; error: string | null; detail: unknown }> {
  try {
    const res = await fetchFn(url, init);
    const raw: unknown = await res.json().catch(() => null);
    const parsed = schema.safeParse(raw);
    const detail =
      typeof raw === "object" && raw !== null && "detail" in raw ? raw.detail : undefined;
    return {
      status: res.status,
      body: parsed.success ? parsed.data : null,
      error:
        typeof raw === "object" && raw !== null && "error" in raw
          ? String(raw.error)
          : null,
      detail,
    };
  } catch {
    return { status: 0, body: null, error: null, detail: undefined };
  }
}

/** The 422 bodies the definition save gates answer with. The engine's detail
 *  is what the operator reads to fix the JSON: either a sentence
 *  (invalid_definition) or the missing block names (unknown_block). */
function invalidFrom(status: number, error: string | null, detail: unknown): InvalidTemplate | null {
  if (status !== 422) return null;
  if (error === "unknown_block" && typeof detail === "object" && detail !== null) {
    const gates = "gates" in detail && Array.isArray(detail.gates) ? detail.gates : [];
    const actions =
      "actions" in detail && Array.isArray(detail.actions) ? detail.actions : [];
    const parts: string[] = [];
    if (gates.length > 0) parts.push(`unknown gate blocks: ${gates.join(", ")}`);
    if (actions.length > 0) parts.push(`unknown action blocks: ${actions.join(", ")}`);
    return {
      ok: false,
      reason: "invalid",
      detail: parts.join(" · ") || "the definition references unknown blocks",
    };
  }
  if (typeof detail === "string" && detail !== "") {
    return { ok: false, reason: "invalid", detail };
  }
  return { ok: false, reason: "invalid", detail: error };
}

export interface WorkflowAdapters {
  list(): Promise<WorkflowReadResult<WorkflowTemplateRow[]>>;
  create(
    input: CreateTemplateInput,
  ): Promise<CreateTemplateResult>;
  update(
    id: string,
    input: UpdateTemplateInput,
  ): Promise<UpdateTemplateResult>;
}

export function createWorkflowAdapters(fetchFn: typeof fetch = fetch): WorkflowAdapters {
  return {
    async list() {
      const res = await readJson(fetchFn, templatesPageSchema, "/api/workflow-templates");
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status !== 200 || res.body === null) {
        return { ok: false as const, reason: "unavailable" as const };
      }
      return { ok: true as const, data: res.body.templates };
    },

    async create(input) {
      const res = await readJson(fetchFn, createdSchema, "/api/workflow-templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 409) {
        return {
          ok: false as const,
          reason: res.error === "default_template_exists" ? ("default_exists" as const) : ("exists" as const),
        };
      }
      if (res.status === 201 && res.body !== null) {
        return { ok: true as const, data: res.body };
      }
      const invalid = invalidFrom(res.status, res.error, res.detail);
      if (invalid !== null) return invalid;
      if (res.status === 400) return { ok: false as const, reason: "invalid" as const, detail: null };
      return { ok: false as const, reason: "unavailable" as const };
    },

    async update(id, input) {
      const res = await readJson(
        fetchFn,
        updatedSchema,
        `/api/workflow-templates/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      if (res.status === 403) return { ok: false as const, reason: "forbidden" as const };
      if (res.status === 404) return { ok: false as const, reason: "not_found" as const };
      if (res.status === 409) return { ok: false as const, reason: "default_exists" as const };
      if (res.status === 200 && res.body !== null) {
        return { ok: true as const, data: res.body.template };
      }
      const invalid = invalidFrom(res.status, res.error, res.detail);
      if (invalid !== null) return invalid;
      if (res.status === 400) return { ok: false as const, reason: "invalid" as const, detail: null };
      return { ok: false as const, reason: "unavailable" as const };
    },
  };
}
