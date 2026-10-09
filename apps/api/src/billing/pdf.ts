import { eq } from "drizzle-orm";
import type { Db } from "@ally/db";
import { schema } from "@ally/db";
import {
  DEFAULT_PDF_TEMPLATE,
  pdfSha256,
  pdfTemplateConfigSchema,
  renderInvoicePdf,
  type InvoicePdfModel,
  type PdfTemplateConfig,
} from "@ally/pdf";
import { readStoredBytes, type Storage } from "@ally/storage";
import { sumCreditCents, effectiveDueCents } from "./credits.ts";
import { sumPaidCents } from "./payments.ts";

/**
 * 发票 PDF 的服务面（#128 首切片）：模板配置读写、渲染模型组装、存档与回填。
 *
 * 三条纪律：
 * - **模型是白名单**（老系统 invoice-pdf/model.ts 的 THE ONE RULE）：从这里到
 *   客户文档的字段逐个点名，发票表将来加的任何列，没人决定让它上单据之前
 *   到不了渲染面。
 * - **存档在确认时刻钉版**：R-12-6 财务确认发出 → 渲染 + 落桶 + 记账（幂等，
 *   ON CONFLICT 让路）。存档失败不拦确认（发票状态是事实，PDF 是它的投影）
 *   ——读路径发现「issued 而无存档」时用当前模板补档（老系统
 *   invoice_pdf_backfill 的同一语义），补上后永不重生成。
 * - **模板只在 DB 单例行**：行不在 = 未配置 = DEFAULT_PDF_TEMPLATE（银行字段
 *   印 "TO BE CONFIGURED" 显眼占位）。PATCH 是 upsert，不预置种子行
 *   （migration 不写业务数据）。
 */

const TEMPLATE_ID = 1;

/** DB 单例行 → 渲染配置（列平铺 → 嵌套；这里只做映射，形状由 zod 面保证） */
function rowToConfig(row: typeof schema.pdfTemplateConfig.$inferSelect): PdfTemplateConfig {
  return pdfTemplateConfigSchema.parse({
    brandColor: row.brandColor,
    company: {
      name: row.companyName,
      addressLines: row.companyAddressLines,
      email: row.companyEmail,
      ...(row.companyPhone !== null ? { phone: row.companyPhone } : {}),
    },
    paymentInstructions: {
      bankName: row.bankName,
      accountName: row.bankAccountName,
      accountNumber: row.bankAccountNumber,
      ...(row.bankRoutingNumber !== null ? { routingNumber: row.bankRoutingNumber } : {}),
      ...(row.paymentReferenceNote !== null ? { referenceNote: row.paymentReferenceNote } : {}),
    },
  });
}

export async function loadPdfTemplate(db: Pick<Db, "select">): Promise<PdfTemplateConfig> {
  const found = await db
    .select()
    .from(schema.pdfTemplateConfig)
    .where(eq(schema.pdfTemplateConfig.id, TEMPLATE_ID))
    .limit(1);
  const row = found[0];
  return row === undefined ? DEFAULT_PDF_TEMPLATE : rowToConfig(row);
}

export async function savePdfTemplate(
  db: Pick<Db, "insert">,
  config: PdfTemplateConfig,
  actorId: string,
): Promise<void> {
  await db
    .insert(schema.pdfTemplateConfig)
    .values({
      id: TEMPLATE_ID,
      brandColor: config.brandColor,
      companyName: config.company.name,
      companyAddressLines: config.company.addressLines,
      companyEmail: config.company.email,
      ...(config.company.phone !== undefined ? { companyPhone: config.company.phone } : {}),
      bankName: config.paymentInstructions.bankName,
      bankAccountName: config.paymentInstructions.accountName,
      bankAccountNumber: config.paymentInstructions.accountNumber,
      ...(config.paymentInstructions.routingNumber !== undefined
        ? { bankRoutingNumber: config.paymentInstructions.routingNumber }
        : {}),
      ...(config.paymentInstructions.referenceNote !== undefined
        ? { paymentReferenceNote: config.paymentInstructions.referenceNote }
        : {}),
      updatedById: actorId,
    })
    .onConflictDoUpdate({
      target: schema.pdfTemplateConfig.id,
      set: {
        brandColor: config.brandColor,
        companyName: config.company.name,
        companyAddressLines: config.company.addressLines,
        companyEmail: config.company.email,
        ...(config.company.phone !== undefined ? { companyPhone: config.company.phone } : {}),
        bankName: config.paymentInstructions.bankName,
        bankAccountName: config.paymentInstructions.accountName,
        bankAccountNumber: config.paymentInstructions.accountNumber,
        ...(config.paymentInstructions.routingNumber !== undefined
          ? { bankRoutingNumber: config.paymentInstructions.routingNumber }
          : {}),
        ...(config.paymentInstructions.referenceNote !== undefined
          ? { paymentReferenceNote: config.paymentInstructions.referenceNote }
          : {}),
        updatedById: actorId,
        updatedAt: new Date(),
      },
    });
}

/**
 * 渲染模型组装：发票头 + 行项 + 实时付款台账，逐字段点名。
 * quantity 是 DB numeric → 字符串，这里转回数（写入侧已收口三位小数）。
 */
export async function buildInvoicePdfModel(
  db: Pick<Db, "select">,
  invoiceId: string,
): Promise<InvoicePdfModel | null> {
  const found = await db
    .select({
      number: schema.invoices.number,
      invoiceType: schema.invoices.invoiceType,
      status: schema.invoices.status,
      currency: schema.invoices.currency,
      issuedAt: schema.invoices.issuedAt,
      dueAt: schema.invoices.dueAt,
      subjectType: schema.invoices.subjectType,
      subjectId: schema.invoices.subjectId,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);
  const row = found[0];
  if (row === undefined) return null;
  const lines = await db
    .select({
      description: schema.invoiceLines.description,
      quantity: schema.invoiceLines.quantity,
      unitPriceCents: schema.invoiceLines.unitPriceCents,
      lineTotalCents: schema.invoiceLines.lineTotalCents,
    })
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(schema.invoiceLines.lineNumber);
  if (lines.length === 0) return null; // 空票不存在（创建面已收口），防御性一致

  const totalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const [creditedCents, paidCents] = await Promise.all([
    sumCreditCents(db, invoiceId),
    sumPaidCents(db, invoiceId),
  ]);

  return {
    number: row.number,
    invoiceType: row.invoiceType,
    status: row.status,
    // 列的唯一合法值（schema 注释同裁），zod 面枚举收口
    currency: "USD",
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    // 客户主数据（#235）进场前无抬头可印；subject 引用不进客户文档
    billTo: null,
    lines: lines.map((line) => ({
      description: line.description,
      quantity: Number(line.quantity),
      unitPriceCents: line.unitPriceCents,
      lineTotalCents: line.lineTotalCents,
    })),
    totalCents,
    paidCents,
    balanceDueCents: effectiveDueCents(totalCents, creditedCents) - paidCents,
  };
}

const invoiceStorageKey = (invoiceId: string): string => `invoices/${invoiceId}.pdf`;

export interface InvoicePdfDocument {
  bytes: Uint8Array;
  contentSha256: string;
  fileName: string;
  /** true = 本次读路径补的档（此前无存档行）；false = 存量或草稿（不落桶） */
  backfilled: boolean;
}

/**
 * 确认时刻的存档（幂等）：渲染 + 落桶 + 记账。返回 null = 发票不存在。
 * 桶里已有对象但行丢了（理论态）——以行为准重新渲染落桶（同 key 覆写）。
 * 调用方在**事务外**调（渲染与桶 I/O 不进 DB 事务），失败由调用方降级为
 * warn 日志——读路径会补档。
 */
export async function archiveInvoiceDocument(
  db: Pick<Db, "select" | "insert">,
  storage: Storage,
  invoiceId: string,
  actorId: string | null,
): Promise<InvoicePdfDocument | null> {
  const model = await buildInvoicePdfModel(db, invoiceId);
  if (model?.status !== "issued") return null;
  const template = await loadPdfTemplate(db);
  return await renderAndRecord(db, storage, invoiceId, model, template, actorId);
}

async function renderAndRecord(
  db: Pick<Db, "select" | "insert">,
  storage: Storage,
  invoiceId: string,
  model: InvoicePdfModel,
  template: PdfTemplateConfig,
  actorId: string | null,
): Promise<InvoicePdfDocument> {
  const bytes = await renderInvoicePdf(model, template);
  const contentSha256 = pdfSha256(bytes);
  const storageKey = invoiceStorageKey(invoiceId);
  await storage.put(storageKey, bytes, "application/pdf");
  await db
    .insert(schema.invoiceDocuments)
    .values({
      invoiceId,
      storageKey,
      contentSha256,
      sizeBytes: bytes.byteLength,
      templateSnapshot: template,
      ...(actorId !== null ? { generatedById: actorId } : {}),
    })
    .onConflictDoNothing({ target: schema.invoiceDocuments.invoiceId });
  return {
    bytes,
    contentSha256,
    fileName: `${model.number}.pdf`,
    backfilled: true,
  };
}

/**
 * 发票 PDF 的读路径：
 * - draft：现渲现回（DRAFT 横幅进版面），**不落桶不记账**——草稿行可改，
 *   存档语义只属于发出的票；
 * - issued：有存档读存档（byte-for-byte 原件）；无存档（确认时存档失败的
 *   理论态）用当前模板补档再回，补档事实在返回值里；
 * - void：调用方自行拒绝（无文档语义由路由层裁）。
 */
export async function getOrBackfillInvoicePdf(
  db: Pick<Db, "select" | "insert">,
  storage: Storage,
  invoiceId: string,
  actorId: string | null,
): Promise<InvoicePdfDocument | { state: "not_found" } | { state: "void" } | { state: "storage" }> {
  const model = await buildInvoicePdfModel(db, invoiceId);
  if (model === null) return { state: "not_found" };
  if (model.status === "void") return { state: "void" };

  if (model.status === "draft") {
    const template = await loadPdfTemplate(db);
    const bytes = await renderInvoicePdf(model, template);
    return {
      bytes,
      contentSha256: pdfSha256(bytes),
      fileName: `DRAFT-${model.number}.pdf`,
      backfilled: false,
    };
  }

  const archived = await db
    .select({
      storageKey: schema.invoiceDocuments.storageKey,
      contentSha256: schema.invoiceDocuments.contentSha256,
      sizeBytes: schema.invoiceDocuments.sizeBytes,
      number: schema.invoices.number,
    })
    .from(schema.invoiceDocuments)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.invoiceDocuments.invoiceId))
    .where(eq(schema.invoiceDocuments.invoiceId, invoiceId))
    .limit(1);
  const row = archived[0];
  if (row !== undefined) {
    const bytes = await readStoredBytes(storage, row.storageKey);
    if (bytes === null) return { state: "storage" };
    return {
      bytes,
      contentSha256: row.contentSha256,
      fileName: `${row.number}.pdf`,
      backfilled: false,
    };
  }

  // issued 而无存档：确认时的存档失败（或存档上线前发出的历史票），补档
  const template = await loadPdfTemplate(db);
  return await renderAndRecord(db, storage, invoiceId, model, template, actorId);
}
