import { Document, renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import { stablePdfBytes } from "./deterministic.ts";
import { InvoicePdfPage } from "./invoice.ts";
import { invoicePdfModelSchema, invoiceTypeLabel, type InvoicePdfModel } from "./model.ts";
import { pdfTemplateConfigSchema, type PdfTemplateConfig } from "./template.ts";

/**
 * 渲染入口：过 zod 面 → React 渲染 → 确定性字节。
 *
 * 模型与模板在这里**再校验**（producers prove their output）：API 层组装
 * 的模型、DB 行映射出的模板，任何一方带进不该有的形状，渲染当场拒绝，
 * 不产出一份带脏字段的客户文档。
 *
 * 返回的字节已过 stablePdfBytes 规范化（两处易变元数据锚定替换为常量）：
 * 同模型同模板 → 同字节 → 同哈希。这是存档 contentSha256 与快照测试的
 * 前提，调用方无需再做任何处理。
 */
export async function renderInvoicePdf(
  model: InvoicePdfModel,
  template: PdfTemplateConfig,
): Promise<Uint8Array> {
  const checkedModel = invoicePdfModelSchema.parse(model);
  const checkedTemplate = pdfTemplateConfigSchema.parse(template);
  // renderToBuffer 的元素树根必须是 Document；单据元数据（title/creator/producer）
  // 属渲染入口——stablePdfBytes 的锚定替换也盯在这里。
  const buffer = await renderToBuffer(
    createElement(
      Document,
      {
        title: `${invoiceTypeLabel(checkedModel.invoiceType)} ${checkedModel.number}`,
        creator: "Ally OS",
        producer: "Ally OS PDF service",
      },
      createElement(InvoicePdfPage, { model: checkedModel, template: checkedTemplate }),
    ),
  );
  return stablePdfBytes(new Uint8Array(buffer));
}

export { pdfSha256, stablePdfBytes } from "./deterministic.ts";
export {
  invoicePdfModelSchema,
  formatMoney,
  formatQuantity,
  NOT_STATED,
  type InvoicePdfModel,
} from "./model.ts";
export { invoiceTypeLabels, invoiceStatusBanners } from "./labels.ts";
export {
  DEFAULT_PDF_TEMPLATE,
  pdfTemplateConfigSchema,
  type PdfTemplateConfig,
} from "./template.ts";
