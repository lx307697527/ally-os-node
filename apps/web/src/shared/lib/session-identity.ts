// Who is signed in, as the header can print it. Ported from ally-os
// apps/allyos session-identity.ts (#129 slice 1); the user-reading half is
// adapted from Supabase's `user_metadata` shape to better-auth's flat
// `{ name, email }` user — the display rules are verbatim.
//
// The ruling (wen-hq, 2026-09-07, ally-os #2127): show the signed-in user's
// name; with no name, the part of the email before `@`; the initials in the
// circle follow the signed-in user.

/** An identity as the shell receives it: already resolved, nothing left to fetch. */
export interface SessionIdentity {
  /** The person's name, trimmed, or `null` when the account carries none. */
  name: string | null;
  /** The sign-in address, or `""` when the account has none. */
  email: string;
}

/** What the chip prints: the circle, and the word beside it. */
export interface SessionIdentityDisplay {
  label: string;
  initials: string;
}

/** The parts of a session user this derivation reads. Declared structurally so
 *  the unit suite can hand it plain objects. */
export interface SessionUserLike {
  name?: string | null;
  email?: string | null;
}

/** A trimmed non-empty string, or `null`. A field holding spaces is an absent field. */
function trimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The first CHARACTER of a word, not its first UTF-16 code unit: `word[0]`
 * splits a surrogate pair (an emoji, or a character outside the basic plane)
 * in half and renders a replacement box. Names arrive from an identity
 * provider and can hold anything.
 */
function firstCharacter(word: string): string {
  return Array.from(word)[0] ?? "";
}

/** Everything before the first `@`; the whole string when there is no `@`. */
function localPartOf(email: string): string {
  const at = email.indexOf("@");
  return (at === -1 ? email : email.slice(0, at)).trim();
}

/**
 * What the session chip prints for this identity — or `null` when it has
 * nothing to print, in which case the shell keeps the brand chip it showed
 * before anyone passed it an identity.
 *
 * The two initials rules are deliberately NOT the same rule:
 *   - from a name: the first letter of each of the first two WORDS, so
 *     `Jordan Lee` is `JL` and a one-word name yields one letter;
 *   - from an address: the first two CHARACTERS of the local part, because
 *     `aost` has no second word to take a letter from.
 */
export function sessionIdentityDisplay(identity: SessionIdentity): SessionIdentityDisplay | null {
  const name = trimmedText(identity.name);
  if (name !== null) {
    const initials = name
      .split(/\s+/)
      .filter((word) => word !== "")
      .slice(0, 2)
      .map(firstCharacter)
      .join("")
      .toUpperCase();
    return { label: name, initials };
  }

  const local = localPartOf(identity.email);
  if (local === "") return null;
  return {
    label: local,
    initials: Array.from(local).slice(0, 2).join("").toUpperCase(),
  };
}

/**
 * Read an identity off the signed-in user, or `null` when there is nothing to
 * read. An account with neither a name nor an address (`@example.com` is a
 * legal shape for a stored address) renders `null`, which the shell answers
 * with the brand chip rather than an empty circle beside an empty word.
 */
export function sessionIdentityFromUser(
  user: SessionUserLike | null | undefined,
): SessionIdentity | null {
  if (!user) return null;
  const name = trimmedText(user.name);
  const email = trimmedText(user.email) ?? "";
  if (name === null && email === "") return null;
  return { name, email };
}
