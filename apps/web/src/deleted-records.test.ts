// #29 slice 2's web half, checked as source text — the same jsdom-free shape
// the audit-log tests use. What matters: the page reads the real endpoints,
// states never lie (forbidden is said, not blanked), restore conflicts are
// named instead of flattened, and the shell/route wiring uses the same table
// the rail prints.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const client = readFileSync(join(SRC, "shared", "lib", "deleted-records-client.ts"), "utf8");
const page = readFileSync(join(SRC, "shared", "pages", "DeletedRecords.tsx"), "utf8");
const app = readFileSync(join(SRC, "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "shared", "shell", "rail-groups.ts"), "utf8");

describe("deleted records client (#29 slice 2)", () => {
  it("reads the one list endpoint with paging parameters, parsed by zod", () => {
    expect(client).toContain("`/api/deleted-records?${params.toString()}`");
    expect(client).toContain("pageSchema.parse");
  });

  it("restore posts to the ledger row and keeps the server's conflict word", () => {
    expect(client).toContain('/restore`');
    expect(client).toContain('reason: "conflict"');
    expect(client).toContain("code: body.data.error");
  });
});

describe("deleted records page (#29 slice 2)", () => {
  it("every state is said: loading, forbidden, unavailable, empty, and the table", () => {
    expect(page).toContain('data-testid="deleted-records-loading"');
    expect(page).toContain('data-testid="deleted-records-forbidden"');
    expect(page).toContain('data-testid="deleted-records-unavailable"');
    expect(page).toContain('data-testid="deleted-records-empty"');
    expect(page).toContain('data-testid="deleted-records-table"');
  });

  it("rows carry when / what / who deleted, the snapshot, and the restore verb", () => {
    expect(page).toContain("row.subjectType");
    expect(page).toContain("row.title");
    expect(page).toContain("row.deletedBy?.name");
    expect(page).toContain("JSON.stringify(row.snapshot, null, 2)");
    expect(page).toContain('data-testid="deleted-records-restore"');
  });

  it("restored is history, not an erasure — the ledger keeps the row and says who restored", () => {
    expect(page).toContain('data-testid="deleted-records-status-restored"');
    expect(page).toContain("row.restoredBy.name");
    expect(page).toContain("history is not rewritten");
  });

  it("restore conflicts are named, never a bare failure", () => {
    expect(page).toContain("restored_already");
    expect(page).toContain("restore_unsupported");
    expect(page).toContain("subject_missing");
  });

  it("pages in fixed steps with an exact-total footer, bounded at both ends", () => {
    expect(page).toContain("offset + PAGE_SIZE < data.total");
    expect(page).toContain("deleted-records-newer");
    expect(page).toContain("deleted-records-older");
  });
});

describe("wiring (#29 slice 2)", () => {
  it("the route exists and the rail item points at it — one table, no drift", () => {
    expect(app).toContain('path="/system/deleted-records"');
    expect(app).toContain("<DeletedRecords />");
    expect(rail).toContain('to: "/system/deleted-records"');
  });

  it("the rail row names its own glyph in the set — no unnamed mark, no shared mark", () => {
    const railSrc = rail;
    expect(railSrc).toContain('icon: "restore"');
    expect(readFileSync(join(SRC, "shared", "shell", "RailIcon.tsx"), "utf8")).toContain('"restore"');
  });
});
