// #219's read half as source text — the same jsdom-free shape the approvals
// page tests use, plus real unit tests for the pure parts (the zod row
// contract and the offline-sync window). What matters: the wall reads the
// real endpoint, every state is said in words, a partially readable wall is
// never shown as complete, and the component stays subject-agnostic so the
// next carrying record (#204) mounts it without forking.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isLateSync, LATE_SYNC_MS, signatureRowSchema } from "../lib/esign-client.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const client = readFileSync(join(SRC, "shared", "lib", "esign-client.ts"), "utf8");
const wall = readFileSync(join(SRC, "shared", "components", "SignatureWall.tsx"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "Approvals.tsx"), "utf8");

const aRow = {
  id: "0b8f8e56-8a92-4f8e-b0e0-4d1f7e37f001",
  subjectType: "approval_action",
  subjectId: "0b8f8e56-8a92-4f8e-b0e0-4d1f7e37f002",
  meaning: "approved",
  recordVersion: "2026-10-09T08:00:00.000Z",
  recordHash: "9f2c1a4e",
  signedAt: "2026-10-09T08:00:00.000Z",
  receivedAt: "2026-10-09T08:00:05.000Z",
  signer: { id: "0b8f8e56-8a92-4f8e-b0e0-4d1f7e37f003", name: "Carol" },
};

describe("esign client (#219)", () => {
  it("reads the real wall endpoint with encoded subject params, zod-parsed", () => {
    expect(client).toContain('fetchFn(`/api/esignatures?${query}`)');
    expect(client).toContain("encodeURIComponent(ref.subjectType)");
    expect(client).toContain("encodeURIComponent(ref.subjectId)");
    expect(client).toContain("signatureRowSchema");
  });

  it("the 404 is a real 'notfound' (subject visibility), everything else unavailable", () => {
    expect(client).toContain('res.status === 404) return { ok: false, reason: "notfound" }');
    expect(client).toContain('reason: "unavailable"');
  });

  it("the row schema keeps the Part 11.50 fields and the record binding", () => {
    const parsed = signatureRowSchema.parse(aRow);
    expect(parsed.meaning).toBe("approved");
    expect(parsed.recordVersion).toBe("2026-10-09T08:00:00.000Z");
    expect(parsed.signer.name).toBe("Carol");
    expect(
      signatureRowSchema.safeParse({ ...aRow, recordVersion: undefined }).success,
    ).toBe(false);
  });
});

describe("signature wall component (#219)", () => {
  it("every state is said: loading, unavailable, empty, rows", () => {
    expect(wall).toContain('data-testid="sig-wall-loading"');
    expect(wall).toContain('data-testid="sig-wall-unavailable"');
    expect(wall).toContain('data-testid="sig-wall-empty"');
    expect(wall).toContain('data-testid="sig-wall-row"');
  });

  it("the display is the Part 11.50 line: name, meaning, time, record version", () => {
    expect(wall).toContain("row.signer.name");
    expect(wall).toContain("meaningLabel(row.meaning)");
    expect(wall).toContain("formatWhen(row.signedAt)");
    expect(wall).toContain('data-testid="sig-wall-row-version"');
  });

  it("one unreadable ref fails the whole wall — never a partial regulatory display", () => {
    expect(wall).toContain("never partial");
    expect(wall).toContain("if (!result.ok) return { ok: false as const, reason: result.reason }");
  });

  it("it never names a subject type — the consumers bring the refs", () => {
    expect(wall).not.toContain("approval_action");
  });
});

describe("offline signatures on the wall (#219 acceptance 4)", () => {
  it("a signature received well after signing is marked as synced later", () => {
    expect(
      isLateSync({
        signedAt: "2026-10-09T08:00:00.000Z",
        receivedAt: "2026-10-09T09:30:00.000Z",
      }),
    ).toBe(true);
    expect(wall).toContain('data-testid="sig-wall-row-synced"');
    expect(wall).toContain("signed offline, synced");
  });

  it("the original signing time stays the wall's time; near-immediate sync is not marked", () => {
    expect(wall).toContain("formatWhen(row.signedAt)");
    expect(
      isLateSync({
        signedAt: "2026-10-09T08:00:00.000Z",
        receivedAt: "2026-10-09T08:00:05.000Z",
      }),
    ).toBe(false);
    // The boundary itself is not "late": receivedAt may trail signedAt by the
    // device clock skew the server already tolerates.
    expect(
      isLateSync({
        signedAt: "2026-10-09T08:00:00.000Z",
        receivedAt: new Date(new Date("2026-10-09T08:00:00.000Z").getTime() + LATE_SYNC_MS).toISOString(),
      }),
    ).toBe(false);
  });
});

describe("wiring on the approvals page (#219 × #221)", () => {
  it("the wall mounts on the request's signed decisions, through the real refs", () => {
    expect(page).toContain("<SignatureWall");
    expect(page).toContain('subjectType: "approval_action"');
    expect(page).toContain("action.signature !== null");
  });

  it("the wall only appears where a signature exists — no permanent empty section", () => {
    expect(page).toContain("view.actions.some((action) => action.signature !== null)");
  });
});
