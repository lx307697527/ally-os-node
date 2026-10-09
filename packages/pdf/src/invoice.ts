import { Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { createElement } from "react";
import {
  formatDate,
  formatMoney,
  formatQuantity,
  invoiceTypeLabel,
  NOT_STATED,
  type InvoicePdfModel,
} from "./model.ts";
import { invoiceStatusBanners } from "./labels.ts";
import type { PdfTemplateConfig } from "./template.ts";

/**
 * 发票版式（#128 首个承载单据）。
 *
 * 版式语言沿用老系统发票 PDF 的骨架（navy 页眉带、FROM/BILL TO 两栏、明细
 * 表、余额块、收款指示框、状态横幅），字段集合跟新系统发票内核（#192）：
 * 老系统特有的批次结算、母子票链在新数据模型里还没有对应事实，不预埋空块。
 *
 * 确定性纪律：这个文件里没有任何时钟、随机数或环境读取——日期全部来自
 * 模型，格式化走纯函数。同模型同模板必须渲染出同字节（存档哈希的前提）。
 *
 * 为什么用 createElement 而不是 JSX：本仓库运行时是 Node 原生加载 .ts
 * （类型擦除，无构建步骤），Node 不加载 .tsx，引入转译 loader 违背零构建
 * 约定。这里手写元素树，与 JSX 产出逐元素等价（版式快照哈希钉住这一点）。
 */

const styles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 48,
    paddingHorizontal: 40,
    fontSize: 9.5,
    fontFamily: "Helvetica",
    color: "#1a2332",
  },
  headerBand: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopLeftRadius: 4,
    borderTopRightRadius: 4,
  },
  headerCompanyName: { color: "#ffffff", fontSize: 14, fontFamily: "Helvetica-Bold" },
  headerTitle: { color: "#ffffff", fontSize: 14, fontFamily: "Helvetica-Bold" },
  statusBanner: {
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: "#fdecea",
    color: "#b3261e",
    fontFamily: "Helvetica-Bold",
    fontSize: 11,
    textAlign: "center",
  },
  metaRow: { flexDirection: "row", marginTop: 14, gap: 28 },
  metaItem: { flexDirection: "column" },
  metaLabel: { fontSize: 7.5, color: "#6b7280", marginBottom: 2 },
  metaValue: { fontFamily: "Helvetica-Bold", fontSize: 10 },
  partyRow: { flexDirection: "row", marginTop: 18, gap: 40 },
  partyBlock: { flex: 1 },
  partyHeading: { fontSize: 7.5, color: "#6b7280", marginBottom: 4 },
  partyName: { fontFamily: "Helvetica-Bold", fontSize: 10.5 },
  partyLine: { fontSize: 9, color: "#374151" },
  table: { marginTop: 20 },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#d1d5db",
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableHeaderText: { fontSize: 7.5, color: "#6b7280", fontFamily: "Helvetica-Bold" },
  tableRow: { flexDirection: "row", paddingVertical: 4 },
  colDescription: { width: "52%" },
  colQty: { width: "14%", textAlign: "right" },
  colUnit: { width: "17%", textAlign: "right" },
  colAmount: { width: "17%", textAlign: "right" },
  cellDescription: { fontSize: 9 },
  cellNumber: { fontSize: 9, textAlign: "right" },
  totalsBlock: { marginTop: 10, alignSelf: "flex-end", width: "42%" },
  totalsRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2.5 },
  totalsLabel: { fontSize: 9, color: "#374151" },
  totalsValue: { fontSize: 9 },
  totalsDivider: { borderBottomWidth: 1, borderBottomColor: "#d1d5db", marginVertical: 3 },
  balanceDueLabel: { fontFamily: "Helvetica-Bold", fontSize: 10.5, color: "#1a2332" },
  balanceDueValue: { fontFamily: "Helvetica-Bold", fontSize: 10.5 },
  paidInFull: {
    marginTop: 14,
    fontFamily: "Helvetica-Bold",
    fontSize: 16,
    textAlign: "center",
  },
  instructionsBox: {
    marginTop: 26,
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 4,
    padding: 12,
  },
  instructionsHeading: {
    fontSize: 7.5,
    color: "#6b7280",
    fontFamily: "Helvetica-Bold",
    marginBottom: 6,
  },
  instructionsLine: { fontSize: 9, color: "#374151", marginBottom: 2 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: "#9ca3af",
  },
});

function PartyBlock(props: { heading: string; name: string; lines: string[] }) {
  return createElement(
    View,
    { style: styles.partyBlock },
    createElement(Text, { style: styles.partyHeading }, props.heading),
    createElement(Text, { style: styles.partyName }, props.name),
    props.lines.map((line, i) => createElement(Text, { key: i, style: styles.partyLine }, line)),
  );
}

function billToLines(model: InvoicePdfModel): string[] {
  if (model.billTo === null) return [NOT_STATED];
  const lines = [...model.billTo.addressLines];
  if (model.billTo.phone !== undefined) lines.push(`Phone: ${model.billTo.phone}`);
  return lines.length > 0 ? lines : [NOT_STATED];
}

export function InvoicePdfPage(props: { model: InvoicePdfModel; template: PdfTemplateConfig }) {
  const { model, template } = props;
  const money = (cents: number) => formatMoney(cents, model.currency);
  const banner = invoiceStatusBanners[model.status];
  const paidInFull = model.status === "issued" && model.balanceDueCents <= 0;

  return createElement(
    Page,
    { size: "A4", style: styles.page },
      createElement(
        View,
        { style: [styles.headerBand, { backgroundColor: template.brandColor }] },
        createElement(Text, { style: styles.headerCompanyName }, template.company.name),
        createElement(
          Text,
          { style: styles.headerTitle },
          invoiceTypeLabel(model.invoiceType).toUpperCase(),
        ),
      ),
      banner !== null ? createElement(Text, { style: styles.statusBanner }, banner) : null,
      createElement(
        View,
        { style: styles.metaRow },
        createElement(
          View,
          { style: styles.metaItem },
          createElement(Text, { style: styles.metaLabel }, "INVOICE NO."),
          createElement(Text, { style: styles.metaValue }, model.number),
        ),
        createElement(
          View,
          { style: styles.metaItem },
          createElement(Text, { style: styles.metaLabel }, "ISSUE DATE"),
          createElement(
            Text,
            { style: styles.metaValue },
            model.issuedAt === null ? NOT_STATED : formatDate(model.issuedAt),
          ),
        ),
        createElement(
          View,
          { style: styles.metaItem },
          createElement(Text, { style: styles.metaLabel }, "DUE DATE"),
          createElement(
            Text,
            { style: styles.metaValue },
            model.dueAt === null ? NOT_STATED : formatDate(model.dueAt),
          ),
        ),
      ),
      createElement(
        View,
        { style: styles.partyRow },
        createElement(PartyBlock, {
          heading: "FROM",
          name: template.company.name,
          lines: [...template.company.addressLines, `Email: ${template.company.email}`],
        }),
        createElement(PartyBlock, {
          heading: "BILL TO",
          name: model.billTo?.name ?? NOT_STATED,
          lines: billToLines(model),
        }),
      ),
      createElement(
        View,
        { style: styles.table },
        createElement(
          View,
          { style: styles.tableHeader },
          createElement(Text, { style: styles.tableHeaderText }, "DESCRIPTION"),
          createElement(Text, { style: [styles.tableHeaderText, styles.colQty] }, "QTY"),
          createElement(Text, { style: [styles.tableHeaderText, styles.colUnit] }, "UNIT PRICE"),
          createElement(Text, { style: [styles.tableHeaderText, styles.colAmount] }, "AMOUNT"),
        ),
        model.lines.map((line, i) =>
          createElement(
            View,
            { key: i, style: styles.tableRow },
            createElement(Text, { style: styles.cellDescription }, line.description),
            createElement(Text, { style: styles.cellNumber }, formatQuantity(line.quantity)),
            createElement(Text, { style: styles.cellNumber }, money(line.unitPriceCents)),
            createElement(Text, { style: styles.cellNumber }, money(line.lineTotalCents)),
          ),
        ),
      ),
      createElement(
        View,
        { style: styles.totalsBlock },
        createElement(
          View,
          { style: styles.totalsRow },
          createElement(Text, { style: styles.totalsLabel }, "Total"),
          createElement(Text, { style: styles.totalsValue }, money(model.totalCents)),
        ),
        createElement(
          View,
          { style: styles.totalsRow },
          createElement(Text, { style: styles.totalsLabel }, "Paid to date"),
          createElement(Text, { style: styles.totalsValue }, money(model.paidCents)),
        ),
        createElement(View, { style: styles.totalsDivider }),
        createElement(
          View,
          { style: styles.totalsRow },
          createElement(Text, { style: styles.balanceDueLabel }, "Balance due"),
          createElement(
            Text,
            { style: [styles.balanceDueValue, { color: template.brandColor }] },
            money(model.balanceDueCents),
          ),
        ),
      ),
      paidInFull
        ? createElement(
            Text,
            { style: [styles.paidInFull, { color: template.brandColor }] },
            "PAID IN FULL",
          )
        : null,
      createElement(
        View,
        { style: styles.instructionsBox },
        createElement(Text, { style: styles.instructionsHeading }, "PAYMENT INSTRUCTIONS"),
        createElement(
          Text,
          { style: styles.instructionsLine },
          "Bank: ",
          template.paymentInstructions.bankName,
        ),
        createElement(
          Text,
          { style: styles.instructionsLine },
          "Account name: ",
          template.paymentInstructions.accountName,
        ),
        createElement(
          Text,
          { style: styles.instructionsLine },
          "Account number: ",
          template.paymentInstructions.accountNumber,
        ),
        template.paymentInstructions.routingNumber !== undefined
          ? createElement(
              Text,
              { style: styles.instructionsLine },
              "Routing number: ",
              template.paymentInstructions.routingNumber,
            )
          : null,
        createElement(
          Text,
          { style: styles.instructionsLine },
          "Payment reference: ",
          model.number,
        ),
        template.paymentInstructions.referenceNote !== undefined
          ? createElement(
              Text,
              { style: styles.instructionsLine },
              template.paymentInstructions.referenceNote,
            )
          : null,
      ),
      createElement(Text, {
        style: styles.footer,
        render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`,
        fixed: true,
      }),
  );
}
