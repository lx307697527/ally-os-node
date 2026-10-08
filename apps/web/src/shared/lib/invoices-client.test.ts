// The invoices client's behavioral half (#192 slice 4): with a fake fetch it
// asserts the real endpoints and bodies, the failure-mode taxonomy (a 409
// carries the server's state code; 404 is its own answer), zod parsing of the
// invoice/ledger shapes — and the pure money arithmetic (formatMoney ported
// verbatim from the server's payment-alerts; dollars→cents and quantity text
// parsed by exact string rules, never float).
import { describe, expect, it } from "vitest";

import {
  createInvoiceAdapters,
  formatMoney,
  parseDollarsToCents,
  parseQuantity,
} from "./invoices-client.ts";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const INVOICE = {
  id: "inv-1",
  number: "INV-202610-1000",
  invoiceType: "balance",
  status: "draft",
  currency: "USD",
  subject: { type: "batch", id: "b-1" },
  totalCents: 150000,
  paidCents: 0,
  paymentStatus: "unpaid",
  issuedAt: null,
  voidedAt: null,
  voidReason: null,
  createdAt: "2026-10-07T08:00:00.000Z",
  updatedAt: "2026-10-07T08:00:00.000Z",
};

const LINE = {
  id: "line-1",
  lineNumber: 1,
  description: "Batch 42 balance",
  quantity: "1000.000",
  unitPriceCents: 150,
  lineTotalCents: 150000,
};

const PAYMENT_ROW = {
  id: "pay-1",
  method: "wire_ach",
  amountCents: 150000,
  surchargeCents: null,
  currency: "USD",
  receivedAt: "2026-10-07T09:00:00.000Z",
  note: "wire ref 88",
  voidedAt: null,
  voidReason: null,
  createdAt: "2026-10-07T09:00:00.000Z",
};

describe("formatMoney", () => {
  it("integer cents → the server's own format: currency prefix, en-US grouping, fixed 2dp", () => {
    expect(formatMoney(150000, "usd")).toBe("USD 1,500.00");
    expect(formatMoney(5, "USD")).toBe("USD 0.05");
    expect(formatMoney(123456789, null)).toBe("1,234,567.89");
    expect(formatMoney(-250, "USD")).toBe("-USD 2.50");
  });
});

describe("parseDollarsToCents", () => {
  it("clean amounts convert by exact string arithmetic — no float on the way", () => {
    expect(parseDollarsToCents("8.45")).toBe(845);
    expect(parseDollarsToCents("1500")).toBe(150000);
    expect(parseDollarsToCents("1,500.5")).toBe(150050);
    expect(parseDollarsToCents("0.01")).toBe(1);
    expect(parseDollarsToCents(" 12.34 ")).toBe(1234);
  });

  it("junk, negatives and three-decimal amounts read as null", () => {
    expect(parseDollarsToCents("")).toBeNull();
    expect(parseDollarsToCents("abc")).toBeNull();
    expect(parseDollarsToCents("-5")).toBeNull();
    expect(parseDollarsToCents("1.234")).toBeNull();
    expect(parseDollarsToCents("1.5,000")).toBeNull();
    expect(parseDollarsToCents("$5")).toBeNull();
  });
});

describe("parseQuantity", () => {
  it("positive values with at most three decimals become numbers", () => {
    expect(parseQuantity("1000")).toBe(1000);
    expect(parseQuantity("0.125")).toBe(0.125);
    expect(parseQuantity("12.5")).toBe(12.5);
  });

  it("zero, negatives, four decimals and junk read as null", () => {
    expect(parseQuantity("0")).toBeNull();
    expect(parseQuantity("-1")).toBeNull();
    expect(parseQuantity("0.0001")).toBeNull();
    expect(parseQuantity("1e3")).toBeNull();
    expect(parseQuantity("")).toBeNull();
  });
});

describe("invoices client (#192 slice 4)", () => {
  it("list hits /api/invoices, with ?status= only when a filter is set", async () => {
    const calls: string[] = [];
    const adapters = createInvoiceAdapters((input) => {
      if (typeof input === "string") calls.push(input);
      return Promise.resolve(jsonRes({ invoices: [INVOICE] }));
    });
    const drafts = await adapters.list("draft");
    expect(calls[0]).toBe("/api/invoices?status=draft");
    expect(drafts).toEqual({ ok: true, data: [INVOICE] });

    await adapters.list();
    expect(calls[1]).toBe("/api/invoices");
  });

  it("list: 403 is forbidden — the page's permission answer, not a blank", async () => {
    const adapters = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 403)));
    await expect(adapters.list()).resolves.toEqual({ ok: false, reason: "forbidden" });
  });

  it("get returns the invoice with its lines; 404 is notfound, junk is unavailable", async () => {
    const ok = createInvoiceAdapters(() =>
      Promise.resolve(jsonRes({ ...INVOICE, lines: [LINE] })),
    );
    await expect(ok.get("inv-1")).resolves.toEqual({
      ok: true,
      data: { ...INVOICE, lines: [LINE] },
    });

    const missing = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "not_found" }, 404)));
    await expect(missing.get("inv-1")).resolves.toEqual({ ok: false, reason: "notfound" });

    const html = createInvoiceAdapters(() =>
      Promise.resolve(new Response("<html>fallback</html>", { status: 200 })),
    );
    await expect(html.get("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("payments parses the ledger shape; 404 is notfound", async () => {
    const ok = createInvoiceAdapters(() =>
      Promise.resolve(
        jsonRes({
          totalCents: 150000,
          paidCents: 150000,
          paymentStatus: "paid",
          payments: [PAYMENT_ROW],
        }),
      ),
    );
    await expect(ok.payments("inv-1")).resolves.toEqual({
      ok: true,
      data: {
        totalCents: 150000,
        paidCents: 150000,
        paymentStatus: "paid",
        payments: [PAYMENT_ROW],
      },
    });

    const missing = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "not_found" }, 404)));
    await expect(missing.payments("inv-1")).resolves.toEqual({ ok: false, reason: "notfound" });
  });

  it("confirm POSTs to the verb route; the outcome comes back as data", async () => {
    const seen: { url: string; method: string }[] = [];
    const adapters = createInvoiceAdapters((input, init) => {
      if (typeof input === "string" && init !== undefined) {
        seen.push({ url: input, method: init.method ?? "" });
      }
      return Promise.resolve(jsonRes({ status: "issued" }));
    });
    const result = await adapters.confirm("inv-1");
    expect(seen[0]).toEqual({ url: "/api/invoices/inv-1/confirm", method: "POST" });
    expect(result).toEqual({ ok: true, data: { outcome: "issued" } });
  });

  it("a 409 carries the server's state code so the page can say the gate", async () => {
    const stale = createInvoiceAdapters(() =>
      Promise.resolve(jsonRes({ error: "not_draft" }, 409)),
    );
    await expect(stale.confirm("inv-1")).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: "not_draft",
    });

    const unnamed = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: 42 }, 409)));
    await expect(unnamed.voidInvoice("inv-1")).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: null,
    });
  });

  it("void sends the trimmed reason, or an empty body when there is none", async () => {
    const seen: string[] = [];
    const adapters = createInvoiceAdapters((input, init) => {
      if (typeof input === "string" && typeof init?.body === "string") seen.push(init.body);
      return Promise.resolve(jsonRes({ status: "voided" }));
    });
    await adapters.voidInvoice("inv-1", "  duplicate  ");
    expect(JSON.parse(seen[0] ?? "{}")).toEqual({ reason: "duplicate" });

    await adapters.voidInvoice("inv-1");
    expect(JSON.parse(seen[1] ?? "{}")).toEqual({});
  });

  it("updateLines PATCHes the whole replacement — lines only, no computed total", async () => {
    const seen: { url: string; method: string; body: string }[] = [];
    const adapters = createInvoiceAdapters((input, init) => {
      if (typeof input === "string" && typeof init?.body === "string") {
        seen.push({ url: input, method: init.method ?? "", body: init.body });
      }
      return Promise.resolve(jsonRes({ status: "ok" }));
    });
    const result = await adapters.updateLines("inv-1", [
      { description: "Batch 42 balance", quantity: 1000, unitPriceCents: 150 },
    ]);
    expect(seen[0]?.url).toBe("/api/invoices/inv-1");
    expect(seen[0]?.method).toBe("PATCH");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      lines: [{ description: "Batch 42 balance", quantity: 1000, unitPriceCents: 150 }],
    });
    expect(result).toEqual({ ok: true, data: { outcome: "ok" } });
  });

  it("network failure reads as unavailable, never throws", async () => {
    const dead = createInvoiceAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.list()).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(dead.get("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(dead.payments("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(dead.confirm("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});
