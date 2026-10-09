import { describe, expect, it } from "vitest";
import { pdfSha256, stablePdfBytes } from "./deterministic.ts";
import { formatMoney, formatQuantity, invoiceTypeLabel, NOT_STATED } from "./model.ts";
import { renderInvoicePdf } from "./render.ts";
import { DEFAULT_PDF_TEMPLATE, pdfTemplateConfigSchema } from "./template.ts";
import type { InvoicePdfModel } from "./model.ts";

export function fixtureModel(overrides?: Partial<InvoicePdfModel>): InvoicePdfModel {
  return {
    number: "INV-202610-1001",
    invoiceType: "deposit",
    status: "issued",
    currency: "USD",
    issuedAt: new Date(Date.UTC(2026, 9, 9, 12, 0, 0)),
    dueAt: new Date(Date.UTC(2026, 9, 24, 12, 0, 0)),
    billTo: {
      name: "Acme Foods Inc.",
      addressLines: ["123 Market Street", "San Francisco, CA 94103"],
      phone: "+1 415 555 0100",
    },
    lines: [
      {
        description: "50% deposit — hot sauce batch #7 (2,000 bottles)",
        quantity: 1,
        unitPriceCents: 480_000,
        lineTotalCents: 480_000,
      },
      {
        description: "Expedited freight share",
        quantity: 1.5,
        unitPriceCents: 120_000,
        lineTotalCents: 180_000,
      },
    ],
    totalCents: 660_000,
    paidCents: 480_000,
    balanceDueCents: 180_000,
    ...overrides,
  };
}

describe("pdf template config schema", () => {
  it("accepts the default template unchanged", () => {
    expect(pdfTemplateConfigSchema.safeParse(DEFAULT_PDF_TEMPLATE).success).toBe(true);
  });

  it("rejects unknown keys and bad brand colors", () => {
    expect(
      pdfTemplateConfigSchema.safeParse({ ...DEFAULT_PDF_TEMPLATE, extra: 1 }).success,
    ).toBe(false);
    expect(
      pdfTemplateConfigSchema.safeParse({ ...DEFAULT_PDF_TEMPLATE, brandColor: "blue" }).success,
    ).toBe(false);
    expect(
      pdfTemplateConfigSchema.safeParse({ ...DEFAULT_PDF_TEMPLATE, brandColor: "#1E3A5F" }).success,
    ).toBe(true);
  });
});

describe("model formatting helpers", () => {
  it("formats cents and quantities for the document", () => {
    expect(formatMoney(480_000, "USD")).toBe("$4,800.00");
    expect(formatMoney(5, "USD")).toBe("$0.05");
    expect(formatMoney(-125, "USD")).toBe("-$1.25");
    expect(formatQuantity(1)).toBe("1");
    expect(formatQuantity(1.5)).toBe("1.5");
    expect(formatQuantity(0.125)).toBe("0.125");
  });

  it("maps invoice types to titles", () => {
    expect(invoiceTypeLabel("deposit")).toBe("Deposit Invoice");
    expect(invoiceTypeLabel("installment")).toBe("Installment Invoice");
  });
});

describe("renderInvoicePdf determinism (#128 archive semantics)", () => {
  it("renders the same model + template to the same hash, repeatedly", async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const bytes = await renderInvoicePdf(fixtureModel(), DEFAULT_PDF_TEMPLATE);
      expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe("%PDF-");
      hashes.add(pdfSha256(bytes));
    }
    expect(hashes.size).toBe(1);
  });

  it("produces different hashes for different models or templates", async () => {
    const baseline = pdfSha256(await renderInvoicePdf(fixtureModel(), DEFAULT_PDF_TEMPLATE));
    const otherModel = pdfSha256(
      await renderInvoicePdf(fixtureModel({ number: "INV-202610-1002" }), DEFAULT_PDF_TEMPLATE),
    );
    const otherTemplate = pdfSha256(
      await renderInvoicePdf(fixtureModel(), {
        ...DEFAULT_PDF_TEMPLATE,
        brandColor: "#7C2D12",
      }),
    );
    expect(otherModel).not.toBe(baseline);
    expect(otherTemplate).not.toBe(baseline);
  });

  it("marks drafts and voided invoices with a status banner", async () => {
    const issued = await renderInvoicePdf(fixtureModel(), DEFAULT_PDF_TEMPLATE);
    const draft = await renderInvoicePdf(fixtureModel({ status: "draft" }), DEFAULT_PDF_TEMPLATE);
    const voided = await renderInvoicePdf(fixtureModel({ status: "void" }), DEFAULT_PDF_TEMPLATE);
    // 状态只经横幅进版面：三态三哈希，且 issued（无横幅）与其余两个不同
    expect(new Set([pdfSha256(issued), pdfSha256(draft), pdfSha256(voided)]).size).toBe(3);
  });

  it("pins the invoice layout against accidental change (snapshot)", async () => {
    // 版式是客户可见面：动它必须是有意为之。有意改版式时，跑一次
    // renderInvoicePdf(fixtureModel(), DEFAULT_PDF_TEMPLATE) 取新哈希更新这里，
    // 并在 PR 里说明版式变了什么（老系统 FROZEN_DOCUMENTS 同裁）。
    const bytes = await renderInvoicePdf(fixtureModel(), DEFAULT_PDF_TEMPLATE);
    expect(pdfSha256(bytes)).toBe(
      "b6463eb7fd9abcb6f3b536c72fe41bf9b11d41b93dbf2e6d8b10104cb9653038",
    );
  });

  it("stays byte-identical through stablePdfBytes round-trip", async () => {
    const bytes = await renderInvoicePdf(fixtureModel(), DEFAULT_PDF_TEMPLATE);
    expect(Buffer.from(stablePdfBytes(bytes)).equals(Buffer.from(bytes))).toBe(true);
  });
});

describe("NOT_STATED", () => {
  it("is the em-dash placeholder", () => {
    expect(NOT_STATED).toBe("—");
  });
});
