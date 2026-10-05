// The task list's data access (#113 slice 1): reads (my assigned / created
// tasks, the assignable-staff directory) and writes (create, edit, status,
// (re)assign). Like the audit PAGE — a primary surface — the adapter reports
// the failure mode instead of flattening it:
//
//   { ok: true, data }                       — a good read/write
//   { ok: false, reason: "forbidden" }       — 403 (reassign by a non-creator)
//   { ok: false, reason: "conflict" }        — 400 (validation, bad assignee)
//   { ok: false, reason: "unavailable" }     — network/5xx/404/body that won't parse
//
// Bodies parse through zod: API responses are external input as far as this
// bundle is concerned (an SPA fallback HTML behind a misrouted proxy must read
// as "unavailable", not as a crash).
import { z } from "zod";

const personSchema = z.object({ id: z.string(), name: z.string() });

const taskRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: z.enum(["open", "done", "cancelled"]),
  dueAt: z.string().nullable(),
  assignee: personSchema.nullable(),
  createdBy: personSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const taskListSchema = z.object({
  tasks: z.array(taskRowSchema),
  total: z.number().int().nonnegative(),
});

const assigneeOptionsSchema = z.object({
  assignees: z.array(personSchema.extend({ email: z.string() })),
});

export type TaskRow = z.infer<typeof taskRowSchema>;
export type TaskStatus = TaskRow["status"];
export type AssigneeOption = z.infer<typeof assigneeOptionsSchema>["assignees"][number];

export type TaskScope = "assigned" | "created";

export interface TaskListQuery {
  scope: TaskScope;
  status?: TaskStatus;
  limit: number;
  offset: number;
}

export interface TaskCreateInput {
  title: string;
  description?: string;
  dueAt?: string;
  assigneeId?: string;
}

export interface TaskPatchInput {
  title?: string;
  description?: string | null;
  dueAt?: string | null;
  status?: TaskStatus;
  assigneeId?: string | null;
}

export type TaskResult =
  | { ok: true; data: TaskRow }
  | { ok: false; reason: "forbidden" | "conflict" | "unavailable" };

/** One task by id (#110 slice 1: the detail page). 404 is meaningful here —
 * the task is gone or the caller is not its creator/assignee — so "notfound"
 * is its own answer, never flattened into "unavailable". */
export type TaskGetResult =
  | { ok: true; data: TaskRow }
  | { ok: false; reason: "notfound" | "unavailable" };

export type TaskListResult =
  | { ok: true; data: z.infer<typeof taskListSchema> }
  | { ok: false; reason: "unavailable" };

export type AssigneeOptionsResult =
  | { ok: true; data: AssigneeOption[] }
  | { ok: false; reason: "unavailable" };

export interface TaskAdapters {
  list(query: TaskListQuery): Promise<TaskListResult>;
  get(id: string): Promise<TaskGetResult>;
  assigneeOptions(): Promise<AssigneeOptionsResult>;
  create(input: TaskCreateInput): Promise<TaskResult>;
  patch(id: string, input: TaskPatchInput): Promise<TaskResult>;
}

export function createTaskAdapters(fetchFn: typeof fetch = fetch): TaskAdapters {
  async function readOk(res: Response): Promise<{ ok: true; data: unknown } | { ok: false; reason: "forbidden" | "conflict" | "unavailable" }> {
    if (res.status === 403) return { ok: false, reason: "forbidden" };
    if (res.status === 400) return { ok: false, reason: "conflict" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    try {
      return { ok: true, data: await res.json() };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  return {
    async list(query: TaskListQuery): Promise<TaskListResult> {
      const params = new URLSearchParams({ scope: query.scope });
      if (query.status !== undefined) params.set("status", query.status);
      params.set("limit", String(query.limit));
      params.set("offset", String(query.offset));
      try {
        const res = await fetchFn(`/api/tasks?${params.toString()}`);
        const gate = await readOk(res);
        // 本人数据的会话路由不会 403/400：任何失败对页面都是「拿不到」
        if (!gate.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: taskListSchema.parse(gate.data) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async get(id: string): Promise<TaskGetResult> {
      try {
        const res = await fetchFn(`/api/tasks/${encodeURIComponent(id)}`);
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const gate = await readOk(res);
        if (!gate.ok) return { ok: false, reason: "unavailable" };
        const parsed = z.object({ task: taskRowSchema.nullable() }).safeParse(gate.data);
        if (!parsed.success || parsed.data.task === null) {
          return { ok: false, reason: "unavailable" };
        }
        return { ok: true, data: parsed.data.task };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async assigneeOptions(): Promise<AssigneeOptionsResult> {
      try {
        const res = await fetchFn("/api/tasks/assignee-options");
        const gate = await readOk(res);
        if (!gate.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: assigneeOptionsSchema.parse(gate.data).assignees };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async create(input: TaskCreateInput): Promise<TaskResult> {
      try {
        const res = await fetchFn("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const gate = await readOk(res);
        if (!gate.ok) return gate;
        const parsed = z.object({ task: taskRowSchema.nullable() }).safeParse(gate.data);
        if (!parsed.success || parsed.data.task === null) {
          return { ok: false, reason: "unavailable" };
        }
        return { ok: true, data: parsed.data.task };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    async patch(id: string, input: TaskPatchInput): Promise<TaskResult> {
      try {
        const res = await fetchFn(`/api/tasks/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const gate = await readOk(res);
        if (!gate.ok) return gate;
        const parsed = z.object({ task: taskRowSchema.nullable() }).safeParse(gate.data);
        if (!parsed.success || parsed.data.task === null) {
          return { ok: false, reason: "unavailable" };
        }
        return { ok: true, data: parsed.data.task };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },
  };
}
