// The approval todo page's data access (#221 slice 3): the to-do list (requests
// whose current level names me or one of my roles), the full request view, and
// the decision verb. Like every primary-surface adapter, it reports the failure
// mode instead of flattening it — the page can say "wrong password", "this was
// already decided", "you need two-factor" as distinct facts:
//
//   { ok: true, data }                       — the read/write landed
//   act(): invalid_credentials / two_factor_required / not_approver /
//          gone / conflict / signature_required / invalid / forbidden /
//          unavailable
//   get(): notfound — meaningful here: the detail gate is the SUBJECT's
//          visibility (see subjects/registry.ts), so a config-named approver
//          who cannot see the record gets a real "not visible", not an error.
//
// Bodies parse through zod: API responses are external input as far as this
// bundle is concerned (an SPA fallback HTML behind a misrouted proxy must read
// as "unavailable", not as a crash).
import { z } from "zod";

const personSchema = z.object({ id: z.string(), name: z.string() });

const esignMeaningSchema = z.enum(["performed", "reviewed", "approved"]);

const todoRowSchema = z.object({
  requestId: z.string(),
  configKey: z.string(),
  configName: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  stepIndex: z.number().int(),
  levelName: z.string(),
  submittedBy: personSchema,
  submittedAt: z.string(),
  payload: z.unknown(),
  requireSignature: z.boolean(),
  signatureMeaning: z.enum(["reviewed", "approved"]),
  // Countersign / vote levels (#221): the row carries its own progress so the
  // page can say "1 of 2 approvals in" and retire the decision buttons once
  // this operator has voted (acting again would just 409).
  levelMode: z.enum(["any", "all", "quorum"]),
  approvedCount: z.number().int(),
  neededApprovals: z.number().int(),
  viewerAlreadyActed: z.boolean(),
});

const actionRowSchema = z.object({
  id: z.string(),
  stepIndex: z.number().int(),
  levelName: z.string(),
  decision: z.enum(["approved", "rejected"]),
  note: z.string().nullable(),
  actor: personSchema,
  createdAt: z.string(),
  signature: z
    .object({ meaning: esignMeaningSchema, signedAt: z.string() })
    .nullable(),
});

const requestViewSchema = z.object({
  id: z.string(),
  configKey: z.string(),
  configName: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  currentStep: z.number().int(),
  currentLevel: z
    .object({ name: z.string(), users: z.array(z.string()), roles: z.array(z.string()) })
    .nullable(),
  payload: z.unknown(),
  submittedBy: personSchema,
  submittedAt: z.string(),
  completedAt: z.string().nullable(),
  actions: z.array(actionRowSchema),
});

const actResponseSchema = z.object({
  requestId: z.string(),
  actionId: z.string(),
  decision: z.enum(["approved", "rejected"]),
  requestStatus: z.enum(["pending", "approved", "rejected"]),
  currentStep: z.number().int(),
});

export type ApprovalTodoRow = z.infer<typeof todoRowSchema>;
export type ApprovalRequestView = z.infer<typeof requestViewSchema>;
export type ApprovalActOutcome = z.infer<typeof actResponseSchema>;

export interface ApprovalActInput {
  decision: "approved" | "rejected";
  note?: string;
  /** The signature ceremony's inputs (signature levels only; sent together). */
  password?: string;
  clientToken?: string;
}

export type ApprovalTodoResult =
  | { ok: true; data: ApprovalTodoRow[] }
  | { ok: false; reason: "unavailable" };

export type ApprovalDetailResult =
  | { ok: true; data: ApprovalRequestView }
  | { ok: false; reason: "notfound" | "unavailable" };

export type ApprovalActResult =
  | { ok: true; data: ApprovalActOutcome }
  | {
      ok: false;
      reason:
        | "invalid_credentials"
        | "two_factor_required"
        | "not_approver"
        | "gone"
        | "conflict"
        | "signature_required"
        | "invalid"
        | "forbidden"
        | "unavailable";
    };

export interface ApprovalAdapters {
  todo(): Promise<ApprovalTodoResult>;
  get(requestId: string): Promise<ApprovalDetailResult>;
  act(requestId: string, input: ApprovalActInput): Promise<ApprovalActResult>;
}

async function errorBody(res: Response): Promise<{ error?: string | undefined }> {
  try {
    return z.object({ error: z.string().optional() }).parse(await res.json());
  } catch {
    return {};
  }
}

export function createApprovalAdapters(fetchFn: typeof fetch = fetch): ApprovalAdapters {
  return {
    async todo(): Promise<ApprovalTodoResult> {
      try {
        const res = await fetchFn("/api/approval-requests/todo");
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = z.object({ requests: z.array(todoRowSchema) }).safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data.requests };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async get(requestId: string): Promise<ApprovalDetailResult> {
      try {
        const res = await fetchFn(`/api/approval-requests/${encodeURIComponent(requestId)}`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const parsed = z.object({ request: requestViewSchema }).safeParse(await res.json());
        if (!parsed.success) return { ok: false, reason: "unavailable" };
        return { ok: true, data: parsed.data.request };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async act(requestId: string, input: ApprovalActInput): Promise<ApprovalActResult> {
      try {
        const res = await fetchFn(`/api/approval-requests/${encodeURIComponent(requestId)}/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (res.ok) {
          const parsed = actResponseSchema.safeParse(await res.json());
          if (!parsed.success) return { ok: false, reason: "unavailable" };
          return { ok: true, data: parsed.data };
        }
        const body = await errorBody(res);
        switch (res.status) {
          case 401:
            return { ok: false, reason: "invalid_credentials" };
          case 403:
            if (body.error === "two_factor_required") return { ok: false, reason: "two_factor_required" };
            if (body.error === "not_approver") return { ok: false, reason: "not_approver" };
            return { ok: false, reason: "forbidden" };
          case 404:
            return { ok: false, reason: "gone" };
          case 409:
            return { ok: false, reason: "conflict" };
          case 422:
            return {
              ok: false,
              reason: body.error === "signature_required" ? "signature_required" : "invalid",
            };
          default:
            return { ok: false, reason: "unavailable" };
        }
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
