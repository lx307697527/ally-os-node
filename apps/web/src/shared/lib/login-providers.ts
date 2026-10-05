// Which social providers this deployment offers (#22 slice 4) — the SPA asks
// the API at runtime instead of carrying a second copy of the deployment
// config (the old system baked ALLY_OS_OAUTH_PROVIDERS into the frontend
// build; the API owns better-auth, so it owns the truth).
//
// THE DEGRADED STATE IS "NO BUTTONS", AND THAT IS DELIBERATE (old system
// FEAT-167): a button for a provider the server won't honor is an action
// offered that cannot succeed — the same defect class as a dead link. So an
// unreachable API, a non-OK answer, or a body that doesn't parse all land on
// an empty list, never on a guess; the parse is zod because the answer is
// external input as far as this bundle is concerned.
//
// The list is NOT filtered here: what the server reports and what this bundle
// can render are two different questions. Sign-in.tsx holds the marks and
// drops anything it has no button for, exactly like the old registry's
// parseEnabledProviders dropped unknown keys at the consumer.
import { z } from "zod";

const providersSchema = z.object({
  providers: z.array(z.string()),
});

/** Never rejects: every failure mode degrades to "no social providers". */
export async function fetchLoginProviders(fetchFn: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchFn("/api/auth-providers");
    if (!res.ok) return [];
    return providersSchema.parse(await res.json()).providers;
  } catch {
    return [];
  }
}
