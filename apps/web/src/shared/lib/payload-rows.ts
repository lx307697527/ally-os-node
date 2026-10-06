// Rendering for approval payloads (#221 slice 3's todo page). The payload is
// owner-domain data the kernel carries verbatim — the page does not know the
// shape, it renders label/value rows generically:
//
//   null / missing            → no rows (a record-only line carries nothing)
//   a plain object            → one row per key, key humanized
//   anything else             → one "Payload" row with the JSON text
//
// Identifier-shaped strings (snake_case enum-ish values like `grant`,
// `sales_lead`) read as words; everything else passes through untouched, so a
// free-text value is never mangled. Pure functions — the unit suite runs them
// directly, no DOM.
export interface PayloadRow {
  /** The raw key as submitted ("" on the fallback row); tests anchor on it. */
  key: string;
  label: string;
  value: string;
}

const IDENTIFIER_LIKE = /^[a-z][a-z0-9_]*$/;

export function humanizeIdentifier(raw: string): string {
  const words = raw.split("_").filter((part) => part !== "");
  if (words.length === 0) return raw;
  const first = must(words[0]);
  const rest = words.slice(1).join(" ");
  return `${first.charAt(0).toUpperCase()}${first.slice(1)}${rest === "" ? "" : ` ${rest}`}`;
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("unexpected missing value");
  return value;
}

function displayValue(value: unknown): string {
  if (typeof value === "string") {
    return IDENTIFIER_LIKE.test(value) ? humanizeIdentifier(value) : value;
  }
  return JSON.stringify(value);
}

export function payloadRows(payload: unknown): PayloadRow[] {
  if (payload === null || payload === undefined) return [];
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return [{ key: "", label: "Payload", value: displayValue(payload) }];
  }
  return Object.entries(payload).map(([key, value]) => ({
    key,
    label: IDENTIFIER_LIKE.test(key) ? humanizeIdentifier(key) : key,
    value: displayValue(value),
  }));
}
