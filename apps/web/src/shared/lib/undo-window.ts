/**
 * 删除撤销的窗口机制（#129 切片 4）。老系统没有 useDeleteWithUndo——issue 引的
 * hook 名来自更早的仓库；老系统最近的先例是 QuoteBuilder2 的纯本地撤销（删的是
 * 未保存的草稿行，Undo 只是拼回本地数组，无窗口期、无服务端往返）。本系统删除的
 * 是已落库数据，所以这是一台新机器，三条语义是刻意裁定：
 *
 *  1. 有界窗口（默认 10s）：撤销是对"还没删"的承诺，窗口一关就必须真删——
 *     无界的"待删"状态等于把删除交给用户忘了点关闭。
 *  2. 替换即提交：窗口里又请求删另一条，旧的那条立即提交——同一时刻只有一条
 *     悬而未决，任何一条都不会因为被替换而悄悄丢掉。
 *  3. 卸载即提交：带着待删项离开页面，提交照做——删除不能因为导航被静默丢弃。
 *
 * commit 失败 = 服务端拒绝 = 行还在，恢复显示（把删掉的行悄悄吞掉是本机制唯一
 * 不允许的失败模式）；onCommitError 只负责上报（打点/提示），不接管恢复。
 *
 * 纯逻辑、无 React：计时器经 UndoScheduler 注入，测试用假时钟直接驱动。
 */

/** 撤销窗口时长。Toast 的 autoDismiss 必须传同一个值——通知的消失与删除的
 * 落库是同一件事的两面，两个常量就会漂移。 */
export const UNDO_WINDOW_MS = 10_000;

export interface UndoWindowCallbacks<T> {
  /** 请求删除的瞬间调用——调用方先把行从界面上藏掉（乐观移除）。 */
  remove: (item: T) => void;
  /** 撤销时调用——把行放回界面。 */
  restore: (item: T) => void;
  /** 窗口关闭（到期/替换/卸载）时调用——真正的删除。 */
  commit: (item: T) => Promise<void>;
  /** commit 失败时调用（行已自动恢复）；缺省无操作。 */
  onCommitError?: (item: T, error: unknown) => void;
}

/** 时间源抽象：安排一个到期回调，返回取消函数。 */
export interface UndoScheduler {
  schedule(fn: () => void, ms: number): () => void;
}

/** 生产时间源：真 setTimeout。vitest 的假时钟直接接管它。 */
export const timeoutScheduler: UndoScheduler = {
  schedule(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

export interface UndoWindow<T> {
  /** 请求删除：乐观移除 + 开窗。窗口里已有待删项时先提交那一项。 */
  request: (item: T) => void;
  /** 撤销待删项；没有待删项时返回 false（调用方可据此忽略）。 */
  undo: () => boolean;
  /** 卸载：有待删项则立即提交。 */
  dispose: () => void;
  /** 当前待删项（只读视图；撤销/提交后为 null）。 */
  readonly pending: T | null;
}

export function createUndoWindow<T>(
  callbacks: UndoWindowCallbacks<T>,
  deps: { scheduler: UndoScheduler; windowMs: number },
): UndoWindow<T> {
  let pending: T | null = null;
  let cancelTimer: (() => void) | null = null;

  function cancelPendingTimer(): void {
    cancelTimer?.();
    cancelTimer = null;
  }

  // 提交是异步的，但窗口的状态机是同步的：cancel 先行，commit 挂到微任务，
  // 失败恢复走 callbacks（restore 把行放回界面）。
  function commitItem(item: T): void {
    callbacks.commit(item).catch((error: unknown) => {
      callbacks.onCommitError?.(item, error);
      callbacks.restore(item);
    });
  }

  function closePending(): void {
    cancelPendingTimer();
    const item = pending;
    pending = null;
    if (item !== null) commitItem(item);
  }

  return {
    request(item: T): void {
      if (pending !== null) closePending();
      callbacks.remove(item);
      pending = item;
      cancelTimer = deps.scheduler.schedule(() => {
        cancelTimer = null;
        closePending();
      }, deps.windowMs);
    },
    undo(): boolean {
      if (pending === null) return false;
      cancelPendingTimer();
      const item = pending;
      pending = null;
      callbacks.restore(item);
      return true;
    },
    dispose(): void {
      if (pending !== null) closePending();
    },
    get pending(): T | null {
      return pending;
    },
  };
}
