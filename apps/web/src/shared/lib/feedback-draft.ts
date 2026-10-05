/**
 * 反馈草稿的纯校验层（#129 切片 4）——老系统 src/modules/feedback 的裁定直译：
 * 「每一条判断都在 .ts 里」——.tsx 里的规则是测试够不到的规则。上限与 API 侧
 * zod（也就是库 CHECK 的镜像）逐值一致：title 200、description 5000、steps 5000。
 * 表单先拦一道是体验（当场指出错在哪），API 的 400 仍是真防线。
 */

/** 表单类型：老 FORM_FEEDBACK_TYPES。process_gap 只有 AI 助手归档，不上表单。 */
export const FORM_FEEDBACK_TYPES = ["bug_report", "feature_request"] as const;
export type FormFeedbackType = (typeof FORM_FEEDBACK_TYPES)[number];

export const FEEDBACK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

export const MAX_TITLE = 200;
export const MAX_BODY = 5000;

export interface FeedbackDraft {
  type: FormFeedbackType;
  title: string;
  description: string;
  stepsToReproduce: string;
  priority: FeedbackPriority;
}

/** 提交前的问题清单；空数组 = 可以提交。文案与字段一一对应。 */
export function feedbackDraftProblems(draft: FeedbackDraft): string[] {
  const problems: string[] = [];
  if (draft.title.trim().length === 0) problems.push("Give the report a title.");
  if (draft.title.trim().length > MAX_TITLE) {
    problems.push(`Keep the title under ${MAX_TITLE} characters.`);
  }
  if (draft.description.trim().length === 0) problems.push("Describe the problem or the idea.");
  if (draft.description.trim().length > MAX_BODY) {
    problems.push(`Keep the description under ${MAX_BODY} characters.`);
  }
  if (draft.type === "bug_report" && draft.stepsToReproduce.trim().length > MAX_BODY) {
    problems.push(`Keep the steps under ${MAX_BODY} characters.`);
  }
  return problems;
}

/** 发上线的体：trim 过、steps 仅 bug 报告携带（老表单的显隐规则）。 */
export function feedbackPayload(draft: FeedbackDraft): {
  type: FormFeedbackType;
  title: string;
  description: string;
  stepsToReproduce?: string;
  priority: FeedbackPriority;
} {
  const payload = {
    type: draft.type,
    title: draft.title.trim(),
    description: draft.description.trim(),
    priority: draft.priority,
  };
  if (draft.type === "bug_report" && draft.stepsToReproduce.trim().length > 0) {
    return { ...payload, stepsToReproduce: draft.stepsToReproduce.trim() };
  }
  return payload;
}
