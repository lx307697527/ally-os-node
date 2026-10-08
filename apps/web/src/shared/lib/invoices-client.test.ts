// The invoices client's behavioral half (#192 slice 4): with a fake fetch it
// asserts the real endpoints and bodies, the failure-mode taxonomy (a 409
// carries the server's state code; 404 is its own answer), zod parsing of the
// invoice/ledger shapes — and the pure money arithmetic (formatMoney ported
// verbatim from the server's payment-alerts; dollars→cents and quantity text
// parsed by exact string rules, never float).
//
// The payment-actions half (#192 remaining) covers the three collection verbs
// finance gets on an issued invoice: record a manual payment (the ledger's
// write), void a booked payment (the correction), and the two payment-link
// channels whose answers carry the surcharge disclosure (gross = principal +
// surcharge) and the customer-facing URL.
import { describe, expect, it } from "vitest";

import {
  createInvoiceAdapters,
  formatMoney,
  isInvoiceOverdue,
  parseDollarsToCents,
  parseDueInDays,
  parseLocalDateTimeToIso,
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
  // R-12-7:API 读面恒带 dueAt(null = 未约定账期)
  dueAt: null,
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

  it("confirm carries the agreed terms — dueInDays in the body only when finance gives one; 0 is a real value (due on receipt)", async () => {
    const bodies: (string | undefined)[] = [];
    const adapters = createInvoiceAdapters((input, init) => {
      if (typeof input === "string" && init !== undefined) {
        bodies.push(typeof init.body === "string" ? init.body : undefined);
      }
      return Promise.resolve(jsonRes({ status: "issued" }));
    });
    await adapters.confirm("inv-1", 30);
    expect(JSON.parse(bodies[0] ?? "null")).toEqual({ dueInDays: 30 });

    await adapters.confirm("inv-1", 0);
    expect(JSON.parse(bodies[1] ?? "null")).toEqual({ dueInDays: 0 });

    await adapters.confirm("inv-1");
    expect(bodies[2]).toBeUndefined();
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

describe("payment actions client (#192 remaining)", () => {
  it("recordPayment POSTs the amount, method and only the facts that exist", async () => {
    const seen: { url: string; method: string; body: string }[] = [];
    const adapters = createInvoiceAdapters((input, init) => {
      if (typeof input === "string" && typeof init?.body === "string") {
        seen.push({ url: input, method: init.method ?? "", body: init.body });
      }
      return Promise.resolve(
        jsonRes({ id: "pay-9", paidCents: 150000, totalCents: 150000, paymentStatus: "paid" }, 201),
      );
    });
    const result = await adapters.recordPayment("inv-1", {
      amountCents: 150000,
      method: "wire_ach",
      receivedAtIso: "2026-10-07T09:00:00.000Z",
      note: "wire ref 88",
    });
    expect(seen[0]?.url).toBe("/api/invoices/inv-1/payments");
    expect(seen[0]?.method).toBe("POST");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
      amountCents: 150000,
      method: "wire_ach",
      receivedAt: "2026-10-07T09:00:00.000Z",
      note: "wire ref 88",
    });
    expect(result).toEqual({
      ok: true,
      data: { paidCents: 150000, totalCents: 150000, paymentStatus: "paid" },
    });

    await adapters.recordPayment("inv-1", { amountCents: 5, method: "card" });
    expect(JSON.parse(seen[1]?.body ?? "{}")).toEqual({ amountCents: 5, method: "card" });
  });

  it("recordPayment maps the state gates — a 409 keeps the server's code, 404 is notfound", async () => {
    const gates = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "not_issued" }, 409)));
    await expect(gates.recordPayment("inv-1", { amountCents: 5, method: "card" })).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: "not_issued",
    });

    const missing = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "not_found" }, 404)));
    await expect(missing.recordPayment("inv-1", { amountCents: 5, method: "card" })).resolves.toEqual({
      ok: false,
      reason: "notfound",
    });

    const refused = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "x" }, 403)));
    await expect(refused.recordPayment("inv-1", { amountCents: 5, method: "card" })).resolves.toEqual({
      ok: false,
      reason: "forbidden",
    });
  });

  it("voidPayment POSTs the trimmed reason and returns the refreshed paid state", async () => {
    const seen: { url: string; body: string }[] = [];
    const adapters = createInvoiceAdapters((input, init) => {
      if (typeof input === "string" && typeof init?.body === "string") {
        seen.push({ url: input, body: init.body });
      }
      return Promise.resolve(
        jsonRes({ status: "voided", paidCents: 0, paymentStatus: "unpaid" }),
      );
    });
    const result = await adapters.voidPayment("pay-1", "  booked twice  ");
    expect(seen[0]?.url).toBe("/api/payments/pay-1/void");
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ reason: "booked twice" });
    expect(result).toEqual({
      ok: true,
      data: { outcome: "voided", paidCents: 0, paymentStatus: "unpaid" },
    });
  });

  it("the Stripe link parses the money disclosure — gross, principal, surcharge, URL", async () => {
    const seen: string[] = [];
    const adapters = createInvoiceAdapters((input) => {
      if (typeof input === "string") seen.push(input);
      return Promise.resolve(
        jsonRes({
          invoiceId: "inv-1",
          number: "INV-202610-1000",
          sessionId: "cs_test_1",
          url: "https://checkout.stripe.com/c/pay/cs_test_1",
          amountCents: 155850,
          principalCents: 150000,
          surchargeCents: 5850,
          currency: "USD",
        }, 201),
      );
    });
    const result = await adapters.stripeLink("inv-1");
    expect(seen[0]).toBe("/api/invoices/inv-1/stripe-checkout");
    expect(result).toEqual({
      ok: true,
      data: {
        url: "https://checkout.stripe.com/c/pay/cs_test_1",
        amountCents: 155850,
        principalCents: 150000,
        surchargeCents: 5850,
        currency: "USD",
      },
    });
  });

  it("the PayPal link parses the approval URL through the same disclosure", async () => {
    const adapters = createInvoiceAdapters(() =>
      Promise.resolve(
        jsonRes({
          invoiceId: "inv-1",
          number: "INV-202610-1000",
          orderId: "5O190127TN364715T",
          url: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T",
          amountCents: 150000,
          principalCents: 150000,
          surchargeCents: 0,
          currency: "USD",
        }, 201),
      ),
    );
    await expect(adapters.paypalLink("inv-1")).resolves.toEqual({
      ok: true,
      data: {
        url: "https://www.paypal.com/checkoutnow?token=5O190127TN364715T",
        amountCents: 150000,
        principalCents: 150000,
        surchargeCents: 0,
        currency: "USD",
      },
    });
  });

  it("a 500 misconfigured body is its own answer — the environment lacks the channel", async () => {
    const unconfigured = createInvoiceAdapters(() =>
      Promise.resolve(jsonRes({ error: "misconfigured" }, 500)),
    );
    await expect(unconfigured.stripeLink("inv-1")).resolves.toEqual({
      ok: false,
      reason: "misconfigured",
    });
    await expect(unconfigured.paypalLink("inv-1")).resolves.toEqual({
      ok: false,
      reason: "misconfigured",
    });

    const broken = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "boom" }, 500)));
    await expect(broken.stripeLink("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("the checkout gates surface as conflicts with their codes", async () => {
    const zero = createInvoiceAdapters(() => Promise.resolve(jsonRes({ error: "nothing_to_collect" }, 409)));
    await expect(zero.stripeLink("inv-1")).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: "nothing_to_collect",
    });

    const rule = createInvoiceAdapters(() =>
      Promise.resolve(jsonRes({ error: "surcharge_rule_unusable" }, 409)),
    );
    await expect(rule.paypalLink("inv-1")).resolves.toEqual({
      ok: false,
      reason: "conflict",
      code: "surcharge_rule_unusable",
    });
  });

  it("a 201 whose body does not parse reads as unavailable, never trusted", async () => {
    const junk = createInvoiceAdapters(() =>
      Promise.resolve(jsonRes({ url: 42, amountCents: "many" }, 201)),
    );
    await expect(junk.stripeLink("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("payment verbs die quietly on a dead network", async () => {
    const dead = createInvoiceAdapters(() => Promise.reject(new Error("down")));
    await expect(dead.recordPayment("inv-1", { amountCents: 5, method: "card" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
    await expect(dead.voidPayment("pay-1", "why")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(dead.stripeLink("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(dead.paypalLink("inv-1")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("parseLocalDateTimeToIso", () => {
  it("a datetime-local value becomes a full UTC ISO string — the server's z.iso.datetime", () => {
    const iso = parseLocalDateTimeToIso("2026-10-07T09:00");
    expect(iso).not.toBeNull();
    expect(new Date(iso ?? "").toISOString()).toBe(iso);
    expect(Date.parse(iso ?? "")).toBe(Date.parse("2026-10-07T09:00"));
  });

  it("empty and unparseable values read as null — the field is optional, junk is not silent", () => {
    expect(parseLocalDateTimeToIso("")).toBeNull();
    expect(parseLocalDateTimeToIso("   ")).toBeNull();
    expect(parseLocalDateTimeToIso("not a date")).toBeNull();
  });
});

describe("parseDueInDays", () => {
  it("whole days within the server's admission (0–365) become numbers — 0 is due on receipt", () => {
    expect(parseDueInDays("30")).toBe(30);
    expect(parseDueInDays("0")).toBe(0);
    expect(parseDueInDays(" 365 ")).toBe(365);
  });

  it("empty, negative, fractional, over-365 and junk read as null — a doomed submission is refused in the form", () => {
    expect(parseDueInDays("")).toBeNull();
    expect(parseDueInDays("-1")).toBeNull();
    expect(parseDueInDays("3.5")).toBeNull();
    expect(parseDueInDays("366")).toBeNull();
    expect(parseDueInDays("net 30")).toBeNull();
  });
});

describe("isInvoiceOverdue", () => {
  const now = new Date("2026-10-09T12:00:00.000Z");

  it("past due and still owing is overdue — the scan's own rule, partial counts as owing", () => {
    expect(isInvoiceOverdue({ dueAt: "2026-10-08T12:00:00.000Z", paymentStatus: "unpaid" }, now)).toBe(true);
    expect(isInvoiceOverdue({ dueAt: "2026-10-08T12:00:00.000Z", paymentStatus: "partial" }, now)).toBe(true);
  });

  it("paid, not yet due and no-terms invoices never are — a $0 invoice is vacuously paid", () => {
    expect(isInvoiceOverdue({ dueAt: "2026-10-08T12:00:00.000Z", paymentStatus: "paid" }, now)).toBe(false);
    expect(isInvoiceOverdue({ dueAt: "2026-10-10T12:00:00.000Z", paymentStatus: "unpaid" }, now)).toBe(false);
    expect(isInvoiceOverdue({ dueAt: null, paymentStatus: "unpaid" }, now)).toBe(false);
  });
});
