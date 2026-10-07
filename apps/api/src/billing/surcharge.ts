import { z } from "zod";

/**
 * 附加费拆分（R-12-2/3，#193 剩余清单的「附加费规则」切片，Part of #192）。
 *
 * 裁决（#232 §10「信用卡和 PayPal 加收 3.9%（可调）」+ 老系统 FEAT-581 的教训）：
 *
 * - **发票面金额不变**：附加费在 checkout 时加收、结账前向客户披露，绝不写进
 *   发票行——发票行合计仍是「结算额」，收款台账的 SUM 语义不变，paid 派生不被
 *   附加费干扰（payments.amount_cents 表注释同文）。
 * - **费率按 principal 计**：先有结算额，费是它的百分比；老系统裁决「cap 按
 *   principal 量」让今天可刷卡的票不会因费率变贵而刷不了。
 * - **拆分只能在 session 创建时算好，搭 metadata 回来**：Stripe 事件只报一个数
 *   （收到的总额），principal/fee 拆分是我们自己的算术，第二个 line item 活不到
 *   事件里。webhook 端用 metadata 对账，四种命名拒绝（老系统 surcharge_split_
 *   test 的同名案例全部随行）：
 *   1. **没有 metadata** = 普通无附加费支付，gross 就是 principal——本切片上线
 *      前创建的所有存量 session 走这条路（回归锚点）；
 *   2. **principal + surcharge ≠ gross**：费率行可被管理员改，建会话时报的价与
 *      实扣额可能真的不一致——两个数字必有一个是错的，而这里无法分辨是哪个，
 *      什么都不入账（502 让 Stripe 重投）；
 *   3. **半申报**（两个键只来一个）= session 由「只懂一半附加费」的东西建的；
 *      推导出缺的一半会让等式构造性成立而什么都证明不了——拒；
 *   4. **surcharge 非正整数**：0 不是「没有附加费」而是「有人算了费但一文没算
 *      到」（列上的 CHECK 同一立场，两态不可并存）；小数、负数、文本同拒。
 *
 * 拒绝的响应面是 webhook 的 502（拿不准的钱不确认，stripe-webhook.ts 文件头）。
 * 老系统的拒绝告警走 Sentry/Slack——本系统刻意不带（#193 既定裁法），失败付款
 * 的站内提醒随通知域的剩余项进场。
 */

/** checkout session metadata 的两个拆分键（stripe.ts 写、本模块读，写读同源） */
export const PRINCIPAL_AMOUNT_METADATA_KEY = "principal_amount_cents";
export const SURCHARGE_AMOUNT_METADATA_KEY = "surcharge_amount_cents";

/** 规则注册表的附加费键（0021 种子，R-12-2）；消费方在 routes/stripe-checkout.ts */
export const CARD_SURCHARGE_RULE_KEY = "payments.card_surcharge_pct";

/** PayPal 渠道的附加费键（0021 种子 3.9%，R-12-3）；消费方 routes/paypal-checkout.ts。
 * 与卡片费率刻意两个键：两个渠道的费率独立可调（卡组织规则与 PayPal 费表互不相干） */
export const PAYPAL_SURCHARGE_RULE_KEY = "payments.paypal_surcharge_pct";

/**
 * 消费方读注册表的期望形状（getRule 的 zod 收口，RULE-007：消费方证明自己知道
 * 规则长什么样）。边界 0–5% 是机械护栏不是业务裁决：3.9% 本身带着 ⚠ 风险标记
 * （可能超卡组织与州上限，业主知情维持，种子行 risk_note 同文）；护栏只拦配置
 * 事故（手滑多打个零），真要提价先过配置工作室改值再放宽消费方。
 */
export const surchargeRateSchema = z.number().min(0).max(5);

/**
 * 附加费 = round(principal × rate%)，整分结果（half up，非负金额与 PG numeric
 * round 同向）。费率先量化到基点（bp = %×100）再整数运算，中途不出浮点金额；
 * principal ≤ int4 上界 × 500bp 远离 2^53，整数乘法安全。费率第三位小数起在
 * bp 量化中丢弃——两位小数的百分比是费率的定义精度。
 */
export function computeSurchargeCents(principalCents: number, ratePct: number): number {
  const basisPoints = Math.round(ratePct * 100);
  return Math.round((principalCents * basisPoints) / 10000);
}

export interface SurchargedCaptureSplit {
  /** 这笔钱里结清发票的部分：进收款台账 amount_cents 的唯一成分 */
  principalCents: number;
  /** 手续费成分；null = 无附加费（「没有」与「算了 0」不可并存，见文件头第 4 条） */
  surchargeCents: number | null;
}

/** metadata 里的金额：字符串/数字，负数、小数、空串、文本一律 null（拒绝而非当零） */
function metadataCents(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * 把银行事实（gross）按 session metadata 拆成 principal + fee；拒绝返回 null，
 * 调用方（normalizeStripeEvent）映射 unparsable → 502。四种命名拒绝见文件头。
 */
export function splitSurchargedCapture(
  grossCents: number,
  metadata: Record<string, unknown>,
): SurchargedCaptureSplit | null {
  const rawPrincipal = metadata[PRINCIPAL_AMOUNT_METADATA_KEY];
  const rawSurcharge = metadata[SURCHARGE_AMOUNT_METADATA_KEY];
  if (rawPrincipal === undefined && rawSurcharge === undefined) {
    return { principalCents: grossCents, surchargeCents: null };
  }
  if (rawPrincipal === undefined || rawSurcharge === undefined) return null;
  const principalCents = metadataCents(rawPrincipal);
  const surchargeCents = metadataCents(rawSurcharge);
  if (principalCents === null || surchargeCents === null) return null;
  if (principalCents <= 0 || surchargeCents <= 0) return null;
  if (principalCents + surchargeCents !== grossCents) return null;
  return { principalCents, surchargeCents };
}
