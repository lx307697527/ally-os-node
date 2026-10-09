import { describe, expect, it } from "vitest";
import { FEEDBACK_MAX_FILE_BYTES, FEEDBACK_MAX_FILES_PER_REPORT, FEEDBACK_URL_TTL_SECONDS, FILE_SUBJECTS, sanitizeFileName } from "./registry.ts";

/**
 * 注册表的纯函数与契约（无 DB）：门裁决的数值承老系统（≤3 张 ≤5MiB、600 秒
 * 下载 TTL——feedback-actions 的 attachment cap 与 SIGNED_URL_TTL_SECONDS），
 * 这里把它们钉住，后来人改数值时至少要路过这条断言想一想。
 */
describe("file subject registry (#31)", () => {
  it("feedback_report 是唯一注册的 subject，数值承老系统", () => {
    expect(Object.keys(FILE_SUBJECTS)).toEqual(["feedback_report"]);
    const feedback = FILE_SUBJECTS.feedback_report;
    expect(feedback?.keyPrefix).toBe("feedback-attachments");
    expect(feedback?.maxFileBytes).toBe(FEEDBACK_MAX_FILE_BYTES);
    expect(feedback?.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(feedback?.maxFilesPerSubject).toBe(FEEDBACK_MAX_FILES_PER_REPORT);
    expect(feedback?.maxFilesPerSubject).toBe(3);
    expect(feedback?.urlTtlSeconds).toBe(FEEDBACK_URL_TTL_SECONDS);
    expect(feedback?.urlTtlSeconds).toBe(600);
  });

  it("feedback 的类型白名单只收图片（fail closed）", () => {
    const admitted = FILE_SUBJECTS.feedback_report?.admittedContentTypes;
    expect(admitted?.has("image/png")).toBe(true);
    expect(admitted?.has("image/jpeg")).toBe(true);
    expect(admitted?.has("application/pdf")).toBe(false);
    expect(admitted?.has("text/plain")).toBe(false);
  });

  describe("sanitizeFileName", () => {
    it("普通名字原样保留（含路径分隔符：名字进不了对象 key，不拦斜杠）", () => {
      expect(sanitizeFileName("a/b/c.png")).toBe("a/b/c.png");
      expect(sanitizeFileName("  trimmed.png  ")).toBe("trimmed.png");
    });

    it.each(["", "   ", "x".repeat(256), "bad\u0000name.png", "bad\u001fname.png"])(
      "rejects %j",
      (name) => {
        expect(sanitizeFileName(name)).toBeNull();
      },
    );
  });
});
