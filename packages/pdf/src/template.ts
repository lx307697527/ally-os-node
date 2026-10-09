import { z } from "zod";

/**
 * PDF 模板配置（#128 统一 PDF 生成服务）。
 *
 * 同一份配置喂给所有单据模板：品牌色 + 我方公司信息 + 收款指示（银行三件套）。
 * 老系统对照 `pdf_template_config` + `company_payment_instructions` 两张表——
 * 本内核合成一份嵌套结构，正是发给客户的那三段内容的唯一权威定义。
 *
 * 这份 zod 面有三方共用：API 的 PATCH 校验（存进去的必须是「能直接渲染」的
 * 形状）、DB 行 ↔ 配置的映射（apps/api/src/billing/pdf.ts）、渲染入口的
 * 再校验（renderInvoicePdf 拒绝没有过面的配置——producers prove their
 * output，ops/rules）。字段全部是**展示事实**，一个业务字段都没有：模板
 * 只回答「单据长什么样」，不回答「单据上有什么数」。
 */

export const PDF_BRAND_COLOR = /^#[0-9a-fA-F]{6}$/;

export const pdfCompanySchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  addressLines: z.array(z.string().trim().min(1).max(200)).max(6),
  email: z.string().trim().min(3).max(200),
  phone: z.string().trim().min(3).max(50).optional(),
});

export const pdfPaymentInstructionsSchema = z.strictObject({
  bankName: z.string().trim().min(1).max(200),
  accountName: z.string().trim().min(1).max(200),
  accountNumber: z.string().trim().min(1).max(100),
  routingNumber: z.string().trim().min(1).max(100).optional(),
  /** 显示在收款框尾的补充说明（如「请附上发票号作为汇款附言」） */
  referenceNote: z.string().trim().min(1).max(500).optional(),
});

export const pdfTemplateConfigSchema = z.strictObject({
  brandColor: z.string().regex(PDF_BRAND_COLOR),
  company: pdfCompanySchema,
  paymentInstructions: pdfPaymentInstructionsSchema,
});

export type PdfCompany = z.infer<typeof pdfCompanySchema>;
export type PdfPaymentInstructions = z.infer<typeof pdfPaymentInstructionsSchema>;
export type PdfTemplateConfig = z.infer<typeof pdfTemplateConfigSchema>;

/**
 * 未配置时的渲染缺省（也是 GET /api/pdf-template-config 在行未落时返回的
 * 同一份内容）：占位公司信息让模板从第一天就能渲染与测试，部署方在配置
 * 面填真值。**部署占位不是真数据**—— Never render real bank details from
 * defaults；银行字段留 "TO BE CONFIGURED" 是刻意的显眼占位，渲染出来一眼
 * 假，不会被误发给客户。
 */
export const DEFAULT_PDF_TEMPLATE: PdfTemplateConfig = {
  brandColor: "#1E3A5F",
  company: {
    name: "Ally OS",
    addressLines: ["Company address not configured"],
    email: "billing@example.com",
  },
  paymentInstructions: {
    bankName: "TO BE CONFIGURED",
    accountName: "TO BE CONFIGURED",
    accountNumber: "TO BE CONFIGURED",
  },
};
