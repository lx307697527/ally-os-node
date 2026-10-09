import { z } from "zod";
import { invoiceTypeLabels } from "./labels.ts";

/**
 * 发票 PDF 的渲染模型（#128 首个承载单据）。
 *
 * THE ONE RULE THAT MATTERS（老系统 invoice-pdf/model.ts 同款纪律）：这是
 * 白名单，不是 spread。API 层从发票行、行项、收款台账组装模型时**逐字段
 * 点名**——发票表将来加的任何列，没人决定让它上客户可见文档之前就到不了
 * 这里。渲染入口用这份 zod 面再校验一次：构造方证明自己的产出。
 *
 * 字段语义跟新系统的发票内核（#192），不是老系统的照搬：没有批次结算块、
 * 没有母子票链（新系统的分期是 invoice_plans，票面只有「Part i of n」还
 * 没有进场）——新数据模型有什么，单据就印什么。
 */

export const INVOICE_PDF_STATUSES = ["draft", "issued", "void"] as const;

export const invoicePdfLineSchema = z.strictObject({
  description: z.string().trim().min(1).max(500),
  /** 三位小数（工时/称量），与 invoice_lines.quantity 同一口径 */
  // zod v4：number 默认拒 Infinity，finite 是 no-op 不再需要
  quantity: z.number().positive().max(1_000_000_000),
  unitPriceCents: z.number().int().min(0).max(2_147_483_647),
  lineTotalCents: z.number().int().min(0).max(2_147_483_647),
});

export const invoicePdfBillToSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  addressLines: z.array(z.string().trim().min(1).max(200)).max(6),
  phone: z.string().trim().min(3).max(50).optional(),
});

export const invoicePdfModelSchema = z.strictObject({
  number: z.string().trim().min(1).max(100),
  invoiceType: z.enum([
    "deposit",
    "balance",
    "sampling_fee",
    "flavor_dev",
    "label_design",
    "storage_fee",
    "customer_material",
    "installment",
  ]),
  status: z.enum(INVOICE_PDF_STATUSES),
  /** 列已落地但当前唯一合法值是 USD（schema 注释同裁）；渲染按 ISO 4217 走 */
  currency: z.enum(["USD"]),
  issuedAt: z.date().nullable(),
  dueAt: z.date().nullable(),
  /** 客户抬头。客户主数据 #235 进场前只有手工票可能带，null 印 NOT_STATED */
  billTo: invoicePdfBillToSchema.nullable(),
  lines: z.array(invoicePdfLineSchema).min(1),
  totalCents: z.number().int().min(0),
  /** 已收（含超收）。收款态是派生值，模型收「算好的数」不收台账行 */
  paidCents: z.number().int().min(0),
  /** 余额 = total − credits − paid（可为负=超收，照实印） */
  balanceDueCents: z.number().int(),
});

export type InvoicePdfLine = z.infer<typeof invoicePdfLineSchema>;
export type InvoicePdfBillTo = z.infer<typeof invoicePdfBillToSchema>;
export type InvoicePdfModel = z.infer<typeof invoicePdfModelSchema>;

/** 「未提供」的印刷形态（老系统 NOT_STATED 同值） */
export const NOT_STATED = "—";

export function invoiceTypeLabel(invoiceType: InvoicePdfModel["invoiceType"]): string {
  return invoiceTypeLabels[invoiceType];
}

/** 金额：整数分 → "$1,234.56"（en-US 章台，ISO 4217 码驱动符号与位数） */
export function formatMoney(cents: number, currency: InvoicePdfModel["currency"]): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** 数量：最多三位小数，去尾零（1 → "1"、1.500 → "1.5"、0.125 → "0.125"） */
export function formatQuantity(quantity: number): string {
  return quantity.toFixed(3).replace(/\.?0+$/, "");
}

/** UTC 日期（到期日/发行日的单据读法；日界争议在数据层已按 UTC 收口） */
export function formatDate(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}
