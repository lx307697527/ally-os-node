import { describe, expect, it } from "vitest";
import { evaluateConditions } from "@ally/automations";
import { createDb } from "@ally/db";
import { blockConditionEvaluator, registerConditionBlock } from "./condition-registry.ts";

// 注册表接缝的纯测试（不需要数据库）：evaluator 的三档答案——未注册 fail
// closed、积木抛错收编成 error、正常裁决透传。db 只是个从不发起查询的空连接
// 池（drizzle 惰性建连）；custom_field 成员的真库行为在 automations.test.ts
// （事件侧）与 due-scanner.test.ts（due 侧）覆盖。
const { db: unusedDb } = createDb("postgresql://127.0.0.1:1/no-such-server");

describe("block condition evaluator (#224 slice 7)", () => {
  it("fails closed on an unregistered block with a nameable error", async () => {
    const evaluate = blockConditionEvaluator({ db: unusedDb });
    const result = await evaluate({ block: "no_such_block", config: null }, {
      action: "task.updated",
      target: "task-1",
      actor: null,
      detail: null,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe("condition block is not registered: no_such_block");
  });

  it("passes the block verdict through and hands over db, target, event, config", async () => {
    const seen: { target: string | null; action: string; config: unknown }[] = [];
    registerConditionBlock("fixture_verdict", (ctx) => {
      seen.push({ target: ctx.target, action: ctx.event.action, config: ctx.config });
      return Promise.resolve(ctx.config === "yes");
    });
    const evaluate = blockConditionEvaluator({ db: unusedDb });
    const ctx = { action: "task.updated", target: "row-9", actor: null, detail: null };
    expect((await evaluate({ block: "fixture_verdict", config: "yes" }, ctx)).passed).toBe(true);
    expect((await evaluate({ block: "fixture_verdict", config: "no" }, ctx)).passed).toBe(false);
    expect(seen).toEqual([
      { target: "row-9", action: "task.updated", config: "yes" },
      { target: "row-9", action: "task.updated", config: "no" },
    ]);
  });

  it("catches a throwing block into an error outcome instead of failing the scan", async () => {
    registerConditionBlock("fixture_throws", () => Promise.reject(new Error("custom field is not configured: task.vip")));
    const evaluate = blockConditionEvaluator({ db: unusedDb });
    const result = await evaluate({ block: "fixture_throws", config: null }, {
      action: "task.updated",
      target: null,
      actor: null,
      detail: null,
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBe("custom field is not configured: task.vip");
  });

  it("evaluateConditions surfaces the evaluator's error outcome to the run row", async () => {
    registerConditionBlock("fixture_throws_again", () => Promise.reject(new Error("bad config")));
    const evaluation = await evaluateConditions(
      [{ block: "fixture_throws_again", config: null }],
      { action: "task.updated", target: null, actor: null, detail: null },
      blockConditionEvaluator({ db: unusedDb }),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.outcomes[0]).toMatchObject({ block: "fixture_throws_again", passed: false, error: "bad config" });
  });
});
