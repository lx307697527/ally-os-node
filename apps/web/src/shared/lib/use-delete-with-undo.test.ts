// Source-text discipline for the undo wiring (the repo's tests are
// jsdom-free, so React behavior is pinned by reading the source; the state
// machine itself is unit-tested in undo-window.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));
const hook = readFileSync(join(SRC, "use-delete-with-undo.ts"), "utf8");
const machine = readFileSync(join(SRC, "undo-window.ts"), "utf8");

describe("useDeleteWithUndo wiring (#129 slice 4)", () => {
  it("窗口实例只建一次（ref 惰性初始化），回调经 ref 透传", () => {
    expect(hook).toContain("windowRef = useRef<UndoWindow<T> | null>(null)");
    expect(hook).toContain("latest.current = callbacks");
  });

  it("卸载即 dispose：删除不因导航被丢", () => {
    expect(hook).toMatch(/return \(\) => \{\s*instance\?\.dispose\(\);\s*\};/);
  });

  it("卸载后的 setState 有守卫（mounted ref）", () => {
    expect(hook).toContain("mounted.current");
  });

  it("生产时间源是真 setTimeout；窗口机制自己管理计时", () => {
    expect(hook).toContain("timeoutScheduler");
    expect(machine).toContain("setTimeout(fn, ms)");
  });

  it("commit 失败自动恢复由窗口机制承担，hook 不吞层", () => {
    expect(machine).toContain("callbacks.restore(item)");
  });
});
