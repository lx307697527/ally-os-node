// Source-text discipline for the settings page and the bell's entry link
// (jsdom-free repo: component behavior contracts are pinned by reading the
// source; the data layer is unit-tested in notification-preferences-client.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(SRC, "NotificationSettings.tsx"), "utf8");
const bell = readFileSync(join(SRC, "..", "components", "NotificationBell.tsx"), "utf8");
const app = readFileSync(join(SRC, "..", "..", "App.tsx"), "utf8");

describe("notification settings page rulings (#116)", () => {
  it("路由注册在 /settings/notifications", () => {
    expect(app).toContain('<Route path="/settings/notifications" element={<NotificationSettings />} />');
  });

  it("加载失败不是「摘要关着」：如实说明并让刷新兜底", () => {
    expect(page).toContain("Couldn&apos;t load your notification settings");
    // 加载失败分支必须 early return，绝不把草稿初始化成「默认关」
    expect(page).toMatch(/if \(loaded === null\) \{\s*setLoadFailed\(true\);\s*return;/);
  });

  it("保存失败不是「已存」：两种结局各有各的话", () => {
    expect(page).toContain("Couldn&apos;t save just now");
    expect(page).toContain('data-testid="notification-settings-saved"');
    expect(page).toMatch(/if \(next === null\) \{\s*setSaveFailed\(true\);\s*return;/);
  });

  it("应用内是本体：文案明说铃铛常开，开关只加邮件", () => {
    expect(page).toContain("The bell in the app always stays on");
  });

  it("保存按钮拿草稿与服务端值的差做门，busy 期间禁用", () => {
    expect(page).toMatch(/preferences\.emailDigest === draft/);
    expect(page).toMatch(/disabled=\{preferences === null \|\| busy/);
  });
});

describe("bell settings entry (#116)", () => {
  it("下拉尾部有去设置的入口，走路由跳转", () => {
    expect(bell).toContain('data-testid="notification-settings-link"');
    expect(bell).toContain('navigate("/settings/notifications")');
  });
});
