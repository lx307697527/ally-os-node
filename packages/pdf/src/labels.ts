/**
 * 单据上的人读标签（英语，ops/rules：user-visible text 是英语）。
 * 与 model.ts 分文件：标签词表是文案，模型是契约，各自演进。
 */

import type { InvoicePdfModel } from "./model.ts";

/** 发票类型的标题形态（老系统按类型换标题的同一裁决，显式映射不猜大小写） */
export const invoiceTypeLabels: Record<InvoicePdfModel["invoiceType"], string> = {
  deposit: "Deposit Invoice",
  balance: "Balance Invoice",
  sampling_fee: "Sampling Fee Invoice",
  flavor_dev: "Flavor Development Invoice",
  label_design: "Label Design Invoice",
  storage_fee: "Storage Fee Invoice",
  customer_material: "Customer Materials Invoice",
  installment: "Installment Invoice",
};

export const invoiceStatusBanners: Record<InvoicePdfModel["status"], string | null> = {
  draft: "DRAFT — NOT YET ISSUED",
  issued: null,
  void: "VOID",
};
