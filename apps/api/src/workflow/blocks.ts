import type { Db } from "@ally/db";

/**
 * 条件积木与动作积木注册表（#220：门槛与进入后动作按名字引用代码里的积木，
 * #232 §4.9「仍然自建」行）。
 *
 * 「合同已签、定金到账、配方师已审」这类条件是业务事实，必须在代码里实现并有
 * 测试——流程 JSON 只组合名字，不内嵌逻辑（老系统把这些写死在 SQL 流转函数里，
 * 新系统拆成可复用的具名积木）。与 esign/registry.ts 同一裁法：积木由属主域
 * 切片随业务域进场注册，**本切片注册表刻意为空**（第一个业务域 #221/#227 进场
 * 时注册第一批）；模板保存时对注册表做存在性校验，引用不存在积木的模板当场
 * 拒绝——在飞实例不会撞上「运行时才发现积木不在」。
 */

/** 积木执行语境：调用方（service）注入连接与 subject 语境，积木不自己找 */
export interface BlockContext {
  db: Db;
  actorId: string;
  subjectType: string;
  subjectId: string;
  instanceId: string;
  /** 模板 JSON 里该积木引用的 config（形状由积木自己校验，引擎不解读） */
  config: unknown;
}

export type ConditionBlock = (ctx: BlockContext) => Promise<boolean>;
export type ActionBlock = (ctx: BlockContext) => Promise<void>;

const CONDITION_BLOCKS: Record<string, ConditionBlock> = {};
const ACTION_BLOCKS: Record<string, ActionBlock> = {};

/** 属主域切片在模块装载时注册；测试用同一条接缝注入夹具积木 */
export function registerConditionBlock(name: string, block: ConditionBlock): void {
  CONDITION_BLOCKS[name] = block;
}

export function registerActionBlock(name: string, block: ActionBlock): void {
  ACTION_BLOCKS[name] = block;
}

export function conditionBlock(name: string): ConditionBlock | undefined {
  return CONDITION_BLOCKS[name];
}

export function actionBlock(name: string): ActionBlock | undefined {
  return ACTION_BLOCKS[name];
}
