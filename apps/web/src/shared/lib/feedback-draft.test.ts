import { describe, expect, it } from "vitest";

import {
  feedbackDraftProblems,
  feedbackPayload,
  FEEDBACK_PRIORITIES,
  FORM_FEEDBACK_TYPES,
  MAX_BODY,
  MAX_TITLE,
} from "./feedback-draft.ts";

function draft(over: Partial<Parameters<typeof feedbackDraftProblems>[0]> = {}) {
  return {
    type: "bug_report" as const,
    title: "Quote totals double-count tax",
    description: "Happens on every quote.",
    stepsToReproduce: "1. open 2. add row",
    priority: "high" as const,
    ...over,
  };
}

describe("feedbackDraftProblems", () => {
  it("完整草稿无问题", () => {
    expect(feedbackDraftProblems(draft())).toEqual([]);
  });

  it("缺标题/缺描述当场指出", () => {
    expect(feedbackDraftProblems(draft({ title: "  " }))).toEqual(["Give the report a title."]);
    expect(feedbackDraftProblems(draft({ description: "" }))).toEqual([
      "Describe the problem or the idea.",
    ]);
  });

  it("超长拦截：标题 200、描述与 steps 5000", () => {
    expect(feedbackDraftProblems(draft({ title: "x".repeat(MAX_TITLE + 1) }))).toEqual([
      `Keep the title under ${MAX_TITLE} characters.`,
    ]);
    expect(feedbackDraftProblems(draft({ description: "x".repeat(MAX_BODY + 1) }))).toEqual([
      `Keep the description under ${MAX_BODY} characters.`,
    ]);
    expect(feedbackDraftProblems(draft({ stepsToReproduce: "x".repeat(MAX_BODY + 1) }))).toEqual([
      `Keep the steps under ${MAX_BODY} characters.`,
    ]);
  });

  it("feature request 不收集 steps（字段根本不显示）", () => {
    const problems = feedbackDraftProblems(
      draft({ type: "feature_request", stepsToReproduce: "x".repeat(MAX_BODY + 1) }),
    );
    expect(problems).toEqual([]);
  });
});

describe("feedbackPayload", () => {
  it("trim 后发出；steps 仅 bug 报告携带且非空", () => {
    expect(feedbackPayload(draft({ title: "  Padded  " }))).toMatchObject({ title: "Padded" });
    expect(feedbackPayload(draft({ stepsToReproduce: "   " }))).not.toHaveProperty("stepsToReproduce");
    expect(
      feedbackPayload(draft({ type: "feature_request", stepsToReproduce: "ignored" })),
    ).not.toHaveProperty("stepsToReproduce");
    const withSteps = feedbackPayload(draft());
    expect(withSteps.stepsToReproduce).toBe("1. open 2. add row");
  });

  it("词表与老系统逐值一致", () => {
    expect([...FORM_FEEDBACK_TYPES]).toEqual(["bug_report", "feature_request"]);
    expect([...FEEDBACK_PRIORITIES]).toEqual(["low", "medium", "high", "critical"]);
  });
});
