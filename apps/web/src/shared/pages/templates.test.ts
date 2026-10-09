// Source-text discipline for the content templates page (jsdom-free repo:
// component behavior contracts are pinned by reading the source; the data
// layer is unit-tested in templates-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "Templates.tsx"), "utf8");
const client = readFileSync(join(SRC, "..", "lib", "templates-client.ts"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");
const rail = readFileSync(join(SRC, "..", "shell", "rail-groups.ts"), "utf8");

describe("content templates page rulings (#225)", () => {
  it("路由注册在 /system/templates,System 区 rail 有一行", () => {
    expect(app).toContain('<Route path="/system/templates" element={<Templates />} />');
    expect(rail).toContain('{ to: "/system/templates", label: "Content templates", nav: "content-templates"');
  });

  it("页面的第一句话就把三条纪律说在前头:启用即接管、没有删除、缺失变量原样发出", () => {
    // JSX 源码有换行缩进,跨行短语用 \s+ 匹配,不钉死排版
    expect(page).toMatch(/takes over as\s+soon as it is saved/);
    expect(page).toContain("there is no delete");
    expect(page).toContain("goes out as-is");
  });

  it("停用的语义在行上说完整:回到内置文案,不是消失", () => {
    expect(page).toContain("Deactivated — builtin wording");
    expect(page).toContain("consumers are back on the builtin wording");
  });

  it("每个状态各有各的话:加载/无权限/不可达/空表/注册表空", () => {
    expect(page).toContain('data-testid="templates-loading"');
    expect(page).toContain('data-testid="templates-forbidden"');
    expect(page).toContain('data-testid="templates-unavailable"');
    expect(page).toContain('data-testid="templates-empty"');
    expect(page).toContain('data-testid="templates-channels-empty"');
  });

  it("写失败的每种结局都按内核给的 reason 说话,含 409 撞 (channel,type) 唯一", () => {
    expect(page).toContain("A template for this channel and type already exists");
    expect(page).toContain("This channel's templates need a subject line");
    // client 把三个内容校验词逐一映射,不落进笼统 invalid
    expect(client).toContain('"unknown_channel"');
    expect(client).toContain('"subject_required"');
    expect(client).toContain('"subject_not_allowed"');
  });

  it("PATCH 是完整内容对象:类型形状上不给部分更新", () => {
    expect(client).toContain("export interface UpdateTemplateInput");
    expect(client).toMatch(/UpdateTemplateInput[\s\S]*isActive: boolean/);
  });

  it("预览走服务端 /preview(一个权威),missingVariables 显性上屏不藏", () => {
    // 页面只经 adapter 调预览;POST 与端点路径在 client 一处
    expect(page).toContain("templatesAdapters.preview(");
    expect(client).toContain('"/api/templates/preview"');
    expect(client).toContain('"POST"');
    expect(page).toContain("preview-missing");
    expect(page).toContain("would carry the placeholders as-is");
  });

  it("版本史与回滚:内容变更新版本,回滚=旧内容落成新版本,历史不改写", () => {
    expect(page).toContain("Version history");
    expect(page).toContain("Restored v");
    expect(page).toContain("history is never rewritten");
    expect(page).toContain("the restore is itself a version");
    // 当前版本不给 Restore 按钮(回滚到当前内容只会空转一版)
    const versionRow = page.slice(page.indexOf('data-testid="templates-version-row"'));
    expect(versionRow).toContain("version !== editTarget.version");
  });

  it("已知类型是文档不是枚举:提示认三封认证邮件,未知类型照配", () => {
    expect(page).toContain("KNOWN_TEMPLATE_TYPES[props.templateType]");
    expect(page).toContain("if (known === undefined) return null;");
    expect(client).toContain("email_verification");
    expect(client).toContain("password_reset");
    expect(client).toContain("account_invite");
    // 转义工序(BUG-285)在编辑点上说清:name/email 转义、link 永不转义
    expect(page).toMatch(/escaped in the HTML body;\s+the link never is/);
  });

  it("表单的本地检查只拦显然破损的提交,服务器仍是唯一权威", () => {
    expect(page).toContain("the server is the authority");
    expect(client).toContain("export function channelWantsSubject(");
    // 镜像表注明「没上表的 channel 默认显示主题框」的兜底方向
    expect(client).toContain("CHANNEL_SUBJECT_REQUIRED[channel] ?? true");
  });
});
