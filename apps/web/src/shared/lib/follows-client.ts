// The follow panel's data access (#110 slice 4): read one subject's follower
// list, follow, unfollow. Same face as the comments client — the failure mode
// is reported, never flattened:
//
//   { ok: true, data }                       — a good read/write
//   { ok: false, reason: "notfound" }        — 404 (subject gone or not yours)
//   { ok: false, reason: "conflict" }        — 400 (bad subject type/id)
//   { ok: false, reason: "unavailable" }     — network/5xx/body that won't parse
//
// Bodies parse through zod: API responses are external input as far as this
// bundle is concerned (an SPA fallback HTML behind a misrouted proxy must read
// as "unavailable", not as a crash).
import { z } from "zod";

const followerSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

const followStateSchema = z.object({
  followers: z.array(followerSchema),
  total: z.number().int().nonnegative(),
  meFollowing: z.boolean(),
});

export type Follower = z.infer<typeof followerSchema>;
export type FollowState = z.infer<typeof followStateSchema>;

export type FollowStateResult =
  | { ok: true; data: FollowState }
  | { ok: false; reason: "notfound" | "conflict" | "unavailable" };

export type FollowToggleResult =
  | { ok: true; data: { meFollowing: boolean } }
  | { ok: false; reason: "notfound" | "conflict" | "unavailable" };

export interface FollowAdapters {
  state(subjectType: string, subjectId: string): Promise<FollowStateResult>;
  follow(subjectType: string, subjectId: string): Promise<FollowToggleResult>;
  unfollow(subjectType: string, subjectId: string): Promise<FollowToggleResult>;
}

export function createFollowAdapters(fetchFn: typeof fetch = fetch): FollowAdapters {
  async function toggle(
    method: "PUT" | "DELETE",
    subjectType: string,
    subjectId: string,
  ): Promise<FollowToggleResult> {
    try {
      const res = await fetchFn(
        `/api/follows/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`,
        { method },
      );
      if (res.status === 404) return { ok: false, reason: "notfound" };
      if (res.status === 400) return { ok: false, reason: "conflict" };
      if (!res.ok) return { ok: false, reason: "unavailable" };
      const body = z.object({ meFollowing: z.boolean() }).parse(await res.json());
      return { ok: true, data: body };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  return {
    async state(subjectType: string, subjectId: string): Promise<FollowStateResult> {
      try {
        const res = await fetchFn(
          `/api/follows/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}`,
        );
        if (res.status === 404) return { ok: false, reason: "notfound" };
        if (res.status === 400) return { ok: false, reason: "conflict" };
        if (!res.ok) return { ok: false, reason: "unavailable" };
        return { ok: true, data: followStateSchema.parse(await res.json()) };
      } catch {
        return { ok: false, reason: "unavailable" };
      }
    },

    follow(subjectType: string, subjectId: string): Promise<FollowToggleResult> {
      return toggle("PUT", subjectType, subjectId);
    },

    unfollow(subjectType: string, subjectId: string): Promise<FollowToggleResult> {
      return toggle("DELETE", subjectType, subjectId);
    },
  };
}
