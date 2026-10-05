import { describe, expect, it } from "vitest";

import { submitFeedback } from "./feedback-client.ts";
import type { FeedbackDraft } from "./feedback-draft.ts";

const DRAFT: FeedbackDraft = {
  type: "bug_report",
  title: "Totals are wrong",
  description: "Description.",
  stepsToReproduce: "1. open",
  priority: "high",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("feedback client (#129 slice 4)", () => {
  it("201 → ok + BR- 编号；体是 feedbackPayload 的输出", async () => {
    let seenBody: string | null = null;
    const result = await submitFeedback(DRAFT, (_input, init) => {
      if (typeof init?.body === "string") seenBody = init.body;
      return Promise.resolve(jsonRes({ reportNumber: "BR-0a1b2c3d" }, 201));
    });
    expect(result).toEqual({ ok: true, reportNumber: "BR-0a1b2c3d" });
    expect(seenBody).toContain('"title":"Totals are wrong"');
    expect(seenBody).toContain('"stepsToReproduce":"1. open"');
  });

  it("400 → invalid + 指向表单的文案", async () => {
    const result = await submitFeedback(DRAFT, () => Promise.resolve(jsonRes({ error: "invalid_request" }, 400)));
    expect(result).toMatchObject({ ok: false, kind: "invalid" });
  });

  it("500 / 网络失败 / 垃圾回执体 → unreachable,不抛", async () => {
    const server = await submitFeedback(DRAFT, () => Promise.resolve(new Response("no", { status: 500 })));
    expect(server).toMatchObject({ ok: false, kind: "unreachable" });

    const dead = await submitFeedback(DRAFT, () => Promise.reject(new Error("down")));
    expect(dead).toMatchObject({ ok: false, kind: "unreachable" });

    const garbage = await submitFeedback(DRAFT, () => Promise.resolve(jsonRes({ nope: true }, 201)));
    expect(garbage).toMatchObject({ ok: false, kind: "unreachable" });
  });
});
