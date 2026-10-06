import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";

/**
 * 编号内核服务（#225 切片 1：可配置单据编号）。
 *
 * 老系统对照：发票号是专用 sequence（FEAT-060），询价引用是计数器表
 * （20260825140000），全写死在 SQL 里、改格式要发版；两套实现的「计数」语义还
 * 分裂过一次（BUG-054：seed 按「下一个号」读、mint 按「上一个号」读，首个号被
 * 永久跳过）。本内核把编号规则变成配置工作室的数据（numbering_rules），分配
 * 收敛为一个进程内函数，由属主域在自己的创建事务里调用。
 *
 * 并发与唯一性：每规则一行计数（numbering_sequences.last_issued，语义恒为
 * 「已发出的最大号」），INSERT（首号 = start_number）+ ON CONFLICT DO UPDATE
 * （+1）RETURNING——同一行上的行锁把并发分配串行化，每个并发调用者拿到互不
 * 相同的号，重复在结构上不可能。这正是老系统「sequence 在并发下唯一」的裁决，
 * 只是计数值变成了可配置规则的产物。
 *
 * 与老 sequence 的差异：计数器是普通表行，**随属主事务回滚**——回滚的单据从未
 * 存在，号归还后可复用，已提交的单据之间编号无 gap 不重复（老 nextval 非事务、
 * 回滚烧号）。代价是分配在属主事务期间持有计数行锁；本系统单据量级下可忽略。
 *
 * 序号单调、永不重置（日期段只渲染进号串）：改格式 = 改之后发出的号的外形，
 * 序号继续——#225 验收第 3 条「修改编号规则后新单据使用新格式，编号不重复」
 * 由单调性结构性保证。
 */

/** 日期段的封闭集合（pgEnum numbering_date_format 同款）；null = 无日期段 */
export const NUMBERING_DATE_FORMATS = ["YYYY", "YYYYMM", "YYYYMMDD"] as const;
export type NumberingDateFormat = (typeof NUMBERING_DATE_FORMATS)[number];

/** 编号规则的渲染所需字段（numbering_rules 行的形状子集） */
export interface NumberingRuleFormat {
  prefix: string;
  dateFormat: NumberingDateFormat | null;
  padding: number;
}

/** 没有可用的生效规则（未配置 / 已停用）：属主域捕获后按「配置缺失」处理 */
export class NoActiveRuleError extends Error {
  constructor(subject: string) {
    super(`numbering: no active rule configured for subject "${subject}"`);
    this.name = "NoActiveRuleError";
  }
}

/**
 * 日期段取 UTC 日历。时区语义是有业务后果的裁决（+8 时区每月头 8 小时会拿到
 * 上个月标签），随第一个真实消费方（报价 #229 / 发票等）一起定——届时经
 * @ally/config 注入，本内核保持无环境依赖；在那之前 UTC 是可测试的确定值。
 */
export function dateSegment(format: NumberingDateFormat, now: Date): string {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  if (format === "YYYY") return year;
  if (format === "YYYYMM") return `${year}${month}`;
  return `${year}${month}${day}`;
}

/** 渲染：prefix + 日期段（有则后跟 "-"，连字符约定承自 INV-202608-0001）+ 零填充序号 */
export function formatDocumentNumber(rule: NumberingRuleFormat, sequence: number, now: Date): string {
  const segment = rule.dateFormat === null ? "" : `${dateSegment(rule.dateFormat, now)}-`;
  return `${rule.prefix}${segment}${String(sequence).padStart(rule.padding, "0")}`;
}

export interface IssuedNumber {
  /** 完整号串（已渲染） */
  number: string;
  /** 裸序号（计数器的值；属主域一般只用 number） */
  sequence: number;
  ruleId: string;
}

/**
 * 原子分配一个编号。事务参数是「能 select/insert 的最小面」——调用方传完整
 * 连接（db: Db）或自己创建事务里的 PgTransaction 都结构满足（与 recordAudit 的
 * Pick<Db, "insert"> 同一收窄；无回调则无需泛型）；{ now } 注入给测试固定时钟。
 *
 * 失败语义：无生效规则抛 NoActiveRuleError（属主域让创建失败——没有编号的单据
 * 不该存在，fail closed）；分配本身不失败第二次（行锁串行化，等一等就轮到）。
 */
export async function allocateDocumentNumber(
  tx: Pick<Db, "select" | "insert">,
  subject: string,
  options: { now?: Date } = {},
): Promise<IssuedNumber> {
  const now = options.now ?? new Date();
  const rules = await tx
    .select()
    .from(schema.numberingRules)
    .where(and(eq(schema.numberingRules.subject, subject), eq(schema.numberingRules.active, true)));
  const rule = rules[0];
  if (rule === undefined) {
    throw new NoActiveRuleError(subject);
  }
  const issued = await tx
    .insert(schema.numberingSequences)
    .values({ ruleId: rule.id, lastIssued: rule.startNumber })
    .onConflictDoUpdate({
      target: schema.numberingSequences.ruleId,
      set: {
        lastIssued: sql`${schema.numberingSequences.lastIssued} + 1`,
        updatedAt: now,
      },
    })
    .returning({ lastIssued: schema.numberingSequences.lastIssued });
  const row = issued[0];
  if (row === undefined) {
    // INSERT..RETURNING 命中行却没返回行：驱动/驱动之上的不变式被破坏，当场响
    throw new Error("numbering allocate: sequence upsert returned no row");
  }
  return {
    number: formatDocumentNumber(rule, row.lastIssued, now),
    sequence: row.lastIssued,
    ruleId: rule.id,
  };
}
