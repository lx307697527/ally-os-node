// #110 attachments slice's web half, checked as source text — the same
// jsdom-free shape the other task-detail tests use. What matters: the page
// reads the real attachment endpoints, Attach (and Remove) are the author's
// verbs only while Download is every viewer's, refusals are said as sentences
// (codes never reach the user), and the signed URL is minted per click — a
// list that logs well must not carry it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "shared", "pages", "TaskDetail.tsx"), "utf8");
const client = readFileSync(join(SRC, "shared", "lib", "comments-client.ts"), "utf8");

describe("task detail attachments (#110)", () => {
  it("the client reads the real attachment endpoints: upload, short-lived URL, remove", () => {
    expect(client).toContain("`/api/comments/${encodeURIComponent(id)}/attachments`");
    expect(client).toContain(
      "`/api/comments/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}/url`",
    );
    expect(client).toContain(
      "`/api/comments/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`",
    );
    expect(client).toContain('method: "POST"');
    expect(client).toContain('method: "DELETE"');
  });

  it("the list read carries attachment rows but never a URL — short-lived URLs are minted per click", () => {
    // the row schema has no url field; the URL endpoint is a separate adapter
    const rowSchema = client.slice(client.indexOf("attachmentRowSchema"), client.indexOf("commentRowSchema"));
    expect(rowSchema).not.toContain("url");
    expect(client).toContain("attachmentUrl(");
    expect(client).toContain("expiresInSeconds: z.number().int().positive()");
  });

  it("Attach file is the author's verb only (inside the `mine` block) and says when an upload is in flight", () => {
    const ownRowControls = page.slice(page.indexOf("{mine ? ("));
    expect(ownRowControls).toContain('data-testid="comment-attach"');
    expect(ownRowControls).toContain('data-testid="comment-attach-input"');
    expect(ownRowControls).toContain('type="file"');
    expect(ownRowControls).toContain("multiple");
    expect(ownRowControls).toContain("Uploading…");
    expect(page).toContain("Only the author can attach files.");
  });

  it("Download is every viewer's; Remove is the author's", () => {
    expect(page).toContain('data-testid="comment-attachment-download"');
    const removeControl = page.slice(page.indexOf("comment-attachment-remove") - 200);
    expect(removeControl).toContain("{mine ? (");
    expect(page).toContain("Only the author can remove an attachment.");
  });

  it("refusals are said as sentences — the server's admission codes never reach the user", () => {
    expect(page).toContain("That file is over the 10 MiB per-file limit.");
    expect(page).toContain("That file type is not on the allowed list.");
    expect(page).toContain("A comment can hold at most 5 attachments.");
    expect(page).toContain("That file is empty.");
    expect(page).toContain("That file name can't be used.");
    expect(page).toContain('data-testid="comment-attachment-error"');
  });

  it("the download restores the original file name via the anchor's download attribute", () => {
    expect(page).toContain("anchor.download = result.data.fileName");
    expect(page).toContain('anchor.rel = "noopener"');
  });

  it("an upload or removal refreshes the list read (attachments are activity rows too)", () => {
    const attachFn = page.slice(page.indexOf("async function attachFiles"), page.indexOf("async function downloadAttachment"));
    expect(attachFn).toContain("props.onChanged()");
    const removeFn = page.slice(page.indexOf("async function removeAttachment"));
    expect(removeFn).toContain("props.onChanged()");
  });
});
