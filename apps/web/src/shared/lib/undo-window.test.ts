import { describe, expect, it } from "vitest";

import { createUndoWindow, UNDO_WINDOW_MS, type UndoScheduler } from "./undo-window.ts";

/** 手动时钟：schedule 不自动触发，测试用 tick(n) 精确推进，绕开 vi 假时钟
 * 与微任务队列的相互干扰。 */
function manualScheduler(): UndoScheduler & { tick(): void } {
  let queued: (() => void) | null = null;
  return {
    schedule(fn) {
      queued = fn;
      return () => {
        queued = null;
      };
    },
    tick() {
      const fn = queued;
      queued = null;
      fn?.();
    },
  };
}

function harness<T>(over: Partial<{ windowMs: number }> = {}) {
  const removed: T[] = [];
  const restored: T[] = [];
  const committed: T[] = [];
  const commitErrors: unknown[] = [];
  const scheduler = manualScheduler();
  const window = createUndoWindow<T>(
    {
      remove: (item) => {
        removed.push(item);
      },
      restore: (item) => {
        restored.push(item);
      },
      commit: (item) => {
        committed.push(item);
        return Promise.resolve();
      },
      onCommitError: (_item, error) => {
        commitErrors.push(error);
      },
    },
    { scheduler, windowMs: over.windowMs ?? UNDO_WINDOW_MS },
  );
  return { window, removed, restored, committed, commitErrors, scheduler };
}

describe("undo window (#129 slice 4)", () => {
  it("窗口时长常量为 10s", () => {
    expect(UNDO_WINDOW_MS).toBe(10_000);
  });

  it("request 乐观移除、开窗；到期自动提交一次", () => {
    const h = harness<string>();
    h.window.request("row-1");
    expect(h.removed).toEqual(["row-1"]);
    expect(h.committed).toEqual([]);
    h.scheduler.tick();
    expect(h.committed).toEqual(["row-1"]);
    // 到期后不再重复提交
    h.scheduler.tick();
    expect(h.committed).toEqual(["row-1"]);
  });

  it("undo 恢复且永不提交", () => {
    const h = harness<string>();
    h.window.request("row-1");
    expect(h.window.undo()).toBe(true);
    expect(h.restored).toEqual(["row-1"]);
    h.scheduler.tick();
    h.scheduler.tick();
    expect(h.committed).toEqual([]);
  });

  it("没有待删项时 undo 返回 false", () => {
    const h = harness<string>();
    expect(h.window.undo()).toBe(false);
    h.window.request("row-1");
    h.scheduler.tick();
    expect(h.window.undo()).toBe(false);
  });

  it("替换即提交：旧项立即提交，新项接窗", () => {
    const h = harness<string>();
    h.window.request("row-1");
    h.window.request("row-2");
    expect(h.committed).toEqual(["row-1"]);
    expect(h.removed).toEqual(["row-1", "row-2"]);
    h.scheduler.tick();
    expect(h.committed).toEqual(["row-1", "row-2"]);
  });

  it("dispose 提交待删项（卸载不丢删除）；无待删项时是 no-op", () => {
    const h = harness<string>();
    h.window.dispose();
    expect(h.committed).toEqual([]);
    h.window.request("row-1");
    h.window.dispose();
    expect(h.committed).toEqual(["row-1"]);
    h.scheduler.tick();
    expect(h.committed).toEqual(["row-1"]);
  });

  it("commit 失败：行被恢复，错误交给 onCommitError", async () => {
    const restored: string[] = [];
    const errors: unknown[] = [];
    const scheduler = manualScheduler();
    const boom = new Error("delete refused");
    const window = createUndoWindow<string>(
      {
        remove: () => undefined,
        restore: (item) => {
          restored.push(item);
        },
        commit: () => Promise.reject(boom),
        onCommitError: (_item, error) => {
          errors.push(error);
        },
      },
      { scheduler, windowMs: UNDO_WINDOW_MS },
    );
    window.request("row-1");
    scheduler.tick();
    // 拒绝路径走微任务
    await Promise.resolve();
    await Promise.resolve();
    expect(restored).toEqual(["row-1"]);
    expect(errors).toEqual([boom]);
  });

  it("到期回调与取消函数配对：undo 后到期回调不再触发", () => {
    const h = harness<string>();
    h.window.request("row-1");
    h.window.undo();
    h.scheduler.tick();
    expect(h.committed).toEqual([]);
    expect(h.window.pending).toBeNull();
  });
});
