// Source-text discipline for the bell (jsdom-free repo: component behavior
// contracts are pinned by reading the source; the data layer and the pure
// face are unit-tested in notifications-client.test.ts /
// notification-face.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const bell = readFileSync(join(SRC, "NotificationBell.tsx"), "utf8");
const poll = readFileSync(join(SRC, "..", "lib", "use-visible-poll.ts"), "utf8");

describe("NotificationBell rulings (#129 slice 4)", () => {
  it("60s 轮询、隐藏暂停、回归即读", () => {
    expect(bell).toContain("NOTIFICATION_POLL_MS = 60_000");
    expect(bell).toContain("useVisiblePoll");
    expect(poll).toContain('document.addEventListener("visibilitychange"');
  });

  it("打开下拉即刷新；写入后从服务端重读，不做本地清零", () => {
    expect(bell).toMatch(/if \(next\) void refresh\(\)/);
    expect(bell).toMatch(/markRead[\s\S]*refresh\(\)/);
    expect(bell).toMatch(/markAllRead[\s\S]*refresh\(\)/);
  });

  it("失败的读不是零：保住上一轮状态并如实标注", () => {
    expect(bell).toContain("setFailed(true)");
    expect(bell).not.toMatch(/summary\(\) === null[\s\S]*setRows\(\[\]\)/);
    expect(bell).toContain("Couldn't load notifications");
  });

  it("组件不自带数据源：adapters 注入，无 fetch 导入", () => {
    expect(bell).not.toContain("createNotificationAdapters");
    expect(bell).not.toContain("fetch(");
    expect(bell).toContain("adapters:");
  });

  it("角标走 unreadBadge（封顶文案集中在一处）", () => {
    expect(bell).toContain("unreadBadge(");
  });

  it("pollMs 可关（测试与未来调用方的退出阀）", () => {
    expect(bell).toContain("pollMs = NOTIFICATION_POLL_MS");
    expect(poll).toContain("if (!intervalMs) return undefined");
  });

  it("有点可去的通知点了就走（#110 切片 1）：先标已读再跳，无处可去只标已读", () => {
    expect(bell).toContain("useNavigate()");
    expect(bell).toContain("if (!row.isRead) markRead(row.id);");
    expect(bell).toContain("if (face.href !== null) navigate(face.href);");
  });
});
