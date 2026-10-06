// #221 slice 3's web half, checked as source text — the same jsdom-free shape
// the tasks-page tests use. What matters: the page reads the real endpoints,
// every state is said in words, the two doors (named on the level vs. seeing
// the record) are both spoken, and the signature ceremony (#219's dialog) sits
// in front of every approval on a signature level — never behind a failed 422.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "approvals-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "Approvals.tsx"), "utf8");
const dialog = readFileSync(join(SRC, "shared", "components", "SignatureDialog.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");
const icons = readFileSync(join(SRC, "shared", "shell", "RailIcon.tsx"), "utf8");

describe("approvals client (#221)", () => {
  it("reads and writes the real endpoints, bodies parsed by zod", () => {
    expect(client).toContain('fetchFn("/api/approval-requests/todo")');
    expect(client).toContain("`/api/approval-requests/${encodeURIComponent(requestId)}`");
    expect(client).toContain('method: "POST"');
    expect(client).toContain("requestViewSchema");
    expect(client).toContain("todoRowSchema");
  });

  it("reports the failure mode instead of flattening it", () => {
    expect(client).toContain('reason: "invalid_credentials"');
    expect(client).toContain('reason: "two_factor_required"');
    expect(client).toContain('reason: "gone"');
    expect(client).toContain('reason: "conflict"');
    expect(client).toContain('reason: "notfound"');
    expect(client).toContain('reason: "unavailable"');
  });

  it("the 403 split follows the server's words, not the status alone", () => {
    expect(client).toContain('body.error === "two_factor_required"');
    expect(client).toContain('body.error === "not_approver"');
  });
});

describe("approvals page (#221)", () => {
  it("every state is said: loading, unavailable, empty, action error, flash, list", () => {
    expect(page).toContain('data-testid="approvals-loading"');
    expect(page).toContain('data-testid="approvals-unavailable"');
    expect(page).toContain('data-testid="approvals-empty"');
    expect(page).toContain('data-testid="approvals-action-error"');
    expect(page).toContain('data-testid="approvals-flash"');
    expect(page).toContain('data-testid="approvals-list"');
  });

  it("the decision context rides the row: submitter, payload rows, signature flag", () => {
    expect(page).toContain("row.submittedBy.name");
    expect(page).toContain("payloadRows(props.row.payload)");
    expect(page).toContain('data-testid="approvals-payload-empty"');
    expect(page).toContain('data-testid="approvals-row-signs"');
  });

  it("the two doors both speak: full record when visible, explicit note when not", () => {
    expect(page).toContain('data-testid="approvals-detail"');
    expect(page).toContain('data-testid="approvals-detail-unseen"');
    expect(page).toContain("limited to people who can see the underlying");
  });

  it("a signature level approves THROUGH the dialog; rejection never signs", () => {
    expect(page).toContain("props.row.requireSignature");
    expect(page).toContain("<SignatureDialog");
    expect(page).toContain('void act("rejected")');
  });

  it("stale inboxes never claim this operator's decision landed", () => {
    expect(page).toContain('"Decision recorded."');
    expect(page).toContain("never \"recorded\": this operator's decision did NOT land");
  });
});

describe("signature dialog (#219 frontend half)", () => {
  it("the ceremony: password re-entry outside the session, one token per attempt", () => {
    expect(dialog).toContain('type="password"');
    expect(dialog).toContain("crypto.randomUUID()");
    expect(dialog).toContain('data-testid="sig-password"');
    expect(dialog).toContain('data-testid="sig-confirm"');
  });

  it("the meaning is displayed as it will be recorded (Part 11.50), fixed by the line", () => {
    expect(dialog).toContain("meaningLabel");
    expect(dialog).toContain('data-testid="sig-meaning"');
  });

  it("it is a dialog: role, modal, labelled", () => {
    expect(dialog).toContain('role="dialog"');
    expect(dialog).toContain('aria-modal="true"');
    expect(dialog).toContain('aria-labelledby="sig-title"');
  });
});

describe("wiring (#221)", () => {
  it("the route exists and the rail item points at it — one table, no drift", () => {
    expect(app).toContain('path="/approvals"');
    expect(app).toContain("<Approvals />");
    expect(rail).toContain('to: "/approvals"');
  });

  it("the rail row names its glyph in the set — no unnamed mark", () => {
    expect(rail).toContain('icon: "approvals"');
    expect(icons).toContain('"approvals"');
  });
});
