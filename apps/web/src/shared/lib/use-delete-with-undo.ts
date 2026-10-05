/**
 * useDeleteWithUndo —— undo-window 的 React 薄壳（#129 切片 4）。状态机与计时
 * 全在 ../lib/undo-window.ts（那里有单测）；这里只做三件事：
 *
 *  1. 把窗口实例放进 ref（整个生命周期一个实例，回调身份变化不重建）；
 *  2. 把 remove/restore 镜像成 React state（`pending`），供调用方渲染撤销
 *     通知条——Toast 的 autoDismiss 传 UNDO_WINDOW_MS，与窗口同源；
 *  3. 卸载时 dispose（待删项立即提交——删除不能因为导航被丢）。
 *
 * 用法（第一个业务删除面落地时）：
 *   const { request, undo, pending } = useDeleteWithUndo({
 *     remove: (id) => setRows(rows.filter(...)),
 *     restore: (id) => setRows(...),
 *     commit: (id) => api.deleteItem(id),
 *   });
 *   {pending && <Toast message="Row deleted" autoDismissMs={UNDO_WINDOW_MS}
 *                      onUndo={() => undo()} onDismiss={() => {}} />}
 */
import { useEffect, useRef, useState } from "react";

import {
  createUndoWindow,
  timeoutScheduler,
  UNDO_WINDOW_MS,
  type UndoWindow,
  type UndoWindowCallbacks,
} from "./undo-window.ts";

export { UNDO_WINDOW_MS };

export function useDeleteWithUndo<T>(
  callbacks: UndoWindowCallbacks<T>,
  windowMs: number = UNDO_WINDOW_MS,
): { request: (item: T) => void; undo: () => boolean; pending: T | null } {
  // 回调经 ref 进窗口：调用方传内联箭头也不会重开窗口、不重启计时。
  const latest = useRef(callbacks);
  useEffect(() => {
    latest.current = callbacks;
  });

  const [pending, setPending] = useState<T | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const windowRef = useRef<UndoWindow<T> | null>(null);
  windowRef.current ??= createUndoWindow<T>({
    remove: (item) => {
      latest.current.remove(item);
      if (mounted.current) setPending(item);
    },
    restore: (item) => {
      latest.current.restore(item);
      if (mounted.current) setPending(null);
    },
    commit: (item) => latest.current.commit(item),
    onCommitError: (item, error) => latest.current.onCommitError?.(item, error),
  }, { scheduler: timeoutScheduler, windowMs });

  useEffect(() => {
    // A closure: TS cannot track the `??=` above into here, so the optional
    // chain is load-bearing in THIS scope (the sync return below narrows).
    const instance = windowRef.current;
    return () => {
      instance?.dispose();
    };
  }, []);

  const current = windowRef.current;
  return {
    request: (item: T) => {
      current.request(item);
    },
    undo: () => current.undo(),
    pending,
  };
}
