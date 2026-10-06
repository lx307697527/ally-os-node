import { getSimplePaths } from "@xstate/graph";
import { describe, expect, it } from "vitest";
import {
  allowedEvents,
  applyWorkflowEvent,
  compileMachine,
  parseWorkflowTemplate,
  referencedBlocks,
  stateDueAt,
} from "./engine.ts";

/**
 * 引擎单元测试（纯函数，无数据库）。
 *
 * 核心一组是 @xstate/graph 的全路径枚举（#220 实现选型的原话：「用
 * @xstate/graph 列出全部路径生成接口测试」）：对样例模板枚举从 initial 出发的
 * 全部简单路径，每条路径逐事件喂给引擎，断言每一步都被接受且落在路径声明的
 * 状态上——「允许的流转引擎都放行」；反过来，任何（状态 × 事件）不在边表里的
 * 组合都被拒绝——「不在允许流转内的状态变更服务端直接拒绝」。
 */

const SAMPLE = {
  initial: "new",
  states: {
    new: { on: { CONTACT: "contacted", DISQUALIFY: "disqualified" } },
    contacted: { on: { QUALIFY: "qualified", RECYCLE: "new" } },
    qualified: {},
    disqualified: {},
  },
};

const ALL_EVENTS = ["CONTACT", "DISQUALIFY", "QUALIFY", "RECYCLE", "STRAY"];

function mustParse(raw: unknown) {
  const parsed = parseWorkflowTemplate(raw);
  if (!parsed.ok) throw new Error(`fixture failed to parse: ${parsed.error}`);
  return parsed.template;
}

describe("parseWorkflowTemplate", () => {
  it("parses a valid template and normalizes defaults", () => {
    const template = mustParse(SAMPLE);
    expect(template.initial).toBe("new");
    expect(template.states.new?.on.CONTACT?.target).toBe("contacted");
    expect(template.states.new?.on.CONTACT?.requireNote).toBe(false);
    expect(template.states.new?.entryActions).toEqual([]);
  });

  it("keeps roles, gates and note requirements on transitions", () => {
    const template = mustParse({
      initial: "new",
      states: {
        new: {
          on: {
            ESCALATE: {
              target: "escalated",
              roles: ["sales_lead", "owner"],
              requireNote: true,
              gates: [{ name: "contract_signed", config: { threshold: 3 } }],
            },
          },
        },
        escalated: {},
      },
    });
    const escalate = template.states.new?.on.ESCALATE;
    expect(escalate?.roles).toEqual(["sales_lead", "owner"]);
    expect(escalate?.requireNote).toBe(true);
    expect(escalate?.gates).toEqual([{ name: "contract_signed", config: { threshold: 3 } }]);
  });

  it("rejects structural garbage with the first issue", () => {
    const cases: unknown[] = [
      undefined,
      {},
      { initial: "new", states: {} },
      { initial: "ghost", states: { new: {} } },
      { initial: "new", states: { new: { on: { GO: "ghost" } } } },
      { initial: "new", states: { new: { on: { GO: "new" } } } },
      { initial: "new", states: { new: {}, extra: {} } },
      { initial: "new", states: { new: { on: { lowercase: "new" } } } },
      { initial: "new", states: { "Bad-Name": {} } },
      { initial: "new", states: { new: { timeoutAfterHours: 0 } } },
      { initial: "new", states: { new: { on: { GO: { target: "new", roles: ["hacker"] } } } } },
    ];
    for (const raw of cases) {
      expect(parseWorkflowTemplate(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it("rejects unreachable states — rooms you can never walk into are template bugs", () => {
    const result = parseWorkflowTemplate({
      initial: "new",
      states: { new: {}, orphan: {} },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("orphan");
  });
});

describe("applyWorkflowEvent", () => {
  it("accepts every step of every simple path from the initial state", () => {
    const template = mustParse(SAMPLE);
    const machine = compileMachine(template);
    for (const path of getSimplePaths(machine)) {
      let current = template.initial;
      // xstate.init 是进入初态的合成步骤，不是业务事件
      const steps = path.steps.filter((step) => !step.event.type.startsWith("xstate."));
      for (const step of steps) {
        const result = applyWorkflowEvent(template, current, step.event.type);
        expect(result.ok, `${current} --${step.event.type}--> ?`).toBe(true);
        if (result.ok) {
          expect(result.transition.target).toBe(step.state.value);
          current = result.transition.target;
        }
      }
      expect(current).toBe(path.state.value);
    }
  });

  it("rejects events the current state does not accept (full matrix)", () => {
    const template = mustParse(SAMPLE);
    for (const stateName of Object.keys(template.states)) {
      for (const event of ALL_EVENTS) {
        const result = applyWorkflowEvent(template, stateName, event);
        if (template.states[stateName]?.on[event] !== undefined) {
          expect(result.ok, `${stateName} --${event}`).toBe(true);
        } else {
          expect(result).toEqual({ ok: false, reason: "event_not_allowed" });
        }
      }
    }
  });

  it("rejects unknown states instead of guessing", () => {
    const template = mustParse(SAMPLE);
    expect(applyWorkflowEvent(template, "rewritten_by_hand", "CONTACT")).toEqual({
      ok: false,
      reason: "unknown_state",
    });
  });
});

describe("stateDueAt / allowedEvents / referencedBlocks", () => {
  it("computes due time from timeoutAfterHours and returns null without it", () => {
    const template = mustParse({
      initial: "new",
      states: {
        new: { on: { NEXT: "contacted" }, timeoutAfterHours: 48 },
        contacted: { on: { DONE: "done" }, timeoutAfterHours: 0.5 },
        done: {},
      },
    });
    const entered = new Date("2026-10-06T00:00:00.000Z");
    expect(stateDueAt(template, "new", entered)).toEqual(new Date("2026-10-08T00:00:00.000Z"));
    expect(stateDueAt(template, "contacted", entered)).toEqual(new Date("2026-10-06T00:30:00.000Z"));
    expect(stateDueAt(template, "done", entered)).toBeNull();
    expect(stateDueAt(template, "ghost", entered)).toBeNull();
  });

  it("accepts the XState string shorthand and object form for transitions alike", () => {
    const template = mustParse({
      initial: "new",
      states: {
        new: { on: { SHORT: "done", LONG: { target: "held", requireNote: true } } },
        held: { on: { SHORT: "done" } },
        done: {},
      },
    });
    expect(template.states.new?.on.SHORT).toMatchObject({ target: "done", requireNote: false });
    expect(template.states.new?.on.LONG).toMatchObject({ target: "held", requireNote: true });
    expect(applyWorkflowEvent(template, "new", "SHORT")).toMatchObject({
      ok: true,
      transition: { target: "done" },
    });
  });

  it("lists events of the current state with their constraints", () => {
    const template = mustParse({
      initial: "new",
      states: {
        new: { on: { ESCALATE: { target: "escalated", requireNote: true }, CLOSE: { target: "done" } } },
        escalated: {},
        done: {},
      },
    });
    const events = allowedEvents(template, "new");
    expect(events.map((e) => e.event).sort()).toEqual(["CLOSE", "ESCALATE"]);
    expect(allowedEvents(template, "done")).toEqual([]);
    expect(allowedEvents(template, "ghost")).toEqual([]);
  });

  it("collects every referenced gate and action name", () => {
    const template = mustParse({
      initial: "new",
      states: {
        new: {
          entryActions: [{ name: "notify_owner" }],
          on: { GO: { target: "done", gates: [{ name: "contract_signed" }, { name: "deposit_paid" }] } },
        },
        done: {},
      },
    });
    expect(referencedBlocks(template)).toEqual({
      gates: ["contract_signed", "deposit_paid"],
      actions: ["notify_owner"],
    });
  });
});
