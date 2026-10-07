import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createStripeGateway,
  normalizeStripeEvent,
  STRIPE_REPLAY_WINDOW_SECONDS,
  StripeGatewayError,
  verifyStripeSignature,
} from "./stripe.ts";
import {
  computeSurchargeCents,
  PRINCIPAL_AMOUNT_METADATA_KEY,
  splitSurchargedCapture,
  SURCHARGE_AMOUNT_METADATA_KEY,
} from "./surcharge.ts";

/**
 * Stripe 渠道内核的单元面（#193）：验签、事件归一、checkout 网关。全部纯函数 +
 * 注入 fetch，无 DB 无网络。
 */

const SECRET = "whsec_test_secret";

/** 与 Stripe 相同的签名方式：`t=<ts>,v1=<hex(HMAC-SHA256("$t.$body"))>` */
function sign(secret: string, body: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret).update(`${String(timestampSeconds)}.${body}`).digest("hex");
  return `t=${String(timestampSeconds)},v1=${mac}`;
}

const NOW = 1_760_000_000; // 固定的「现在」，窗口断言对真实时钟免疫

describe("verifyStripeSignature (#193)", () => {
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a correctly signed payload at the window edge", () => {
    const at = NOW + STRIPE_REPLAY_WINDOW_SECONDS; // 窗口边界（含）之内都算新鲜
    expect(
      verifyStripeSignature({ secret: SECRET, header: sign(SECRET, body, at), rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: true });
  });

  it("accepts when any of several v1 candidates matches (key rotation)", () => {
    const header = `${sign("whsec_old", body, NOW)},v1=${createHmac("sha256", SECRET).update(`${String(NOW)}.${body}`).digest("hex")}`;
    expect(verifyStripeSignature({ secret: SECRET, header, rawBody: body, nowSeconds: NOW })).toEqual({ ok: true });
  });

  it("refuses a signature computed over different bytes (tampered body)", () => {
    const header = sign(SECRET, body, NOW);
    expect(
      verifyStripeSignature({ secret: SECRET, header, rawBody: `${body} `, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature from a different secret", () => {
    expect(
      verifyStripeSignature({ secret: "whsec_other", header: sign(SECRET, body, NOW), rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a stale timestamp just past the replay window", () => {
    const at = NOW - STRIPE_REPLAY_WINDOW_SECONDS - 1;
    expect(
      verifyStripeSignature({ secret: SECRET, header: sign(SECRET, body, at), rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("refuses a far-future timestamp (a signature must not be parked for later)", () => {
    const at = NOW + STRIPE_REPLAY_WINDOW_SECONDS + 1;
    expect(
      verifyStripeSignature({ secret: SECRET, header: sign(SECRET, body, at), rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("refuses a non-numeric timestamp (NaN must read as not-fresh, fail closed)", () => {
    const header = `t=garbage,v1=${createHmac("sha256", SECRET).update(`garbage.${body}`).digest("hex")}`;
    expect(
      verifyStripeSignature({ secret: SECRET, header, rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "stale_timestamp" });
  });

  it("refuses a missing or malformed signature header", () => {
    expect(
      verifyStripeSignature({ secret: SECRET, header: undefined, rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "missing_header" });
    expect(
      verifyStripeSignature({ secret: SECRET, header: "", rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "missing_header" });
    expect(
      verifyStripeSignature({ secret: SECRET, header: "v1=deadbeef", rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "malformed_header" });
    expect(
      verifyStripeSignature({ secret: SECRET, header: `t=${String(NOW)}`, rawBody: body, nowSeconds: NOW }),
    ).toEqual({ ok: false, reason: "malformed_header" });
  });
});

describe("computeSurchargeCents (#193 surcharge)", () => {
  it("computes 3.9% of the principal in whole cents via basis points", () => {
    expect(computeSurchargeCents(150000, 3.9)).toBe(5850); // $1,500 → $58.50
    expect(computeSurchargeCents(100000, 3.9)).toBe(3900);
  });

  it("rounds half up to whole cents and quantizes the rate to basis points", () => {
    expect(computeSurchargeCents(12345, 3.9)).toBe(481); // 481.455 → 481
    expect(computeSurchargeCents(1, 3.9)).toBe(0); // sub-cent fee rounds away to "no surcharge"
    expect(computeSurchargeCents(100000, 4.25)).toBe(4250); // rate quantized to 425 bp（第三位小数不是定义精度）
  });

  it("treats the 0% kill switch as no fee at all", () => {
    expect(computeSurchargeCents(150000, 0)).toBe(0);
  });
});

describe("splitSurchargedCapture (#193 surcharge)", () => {
  // 老系统 surcharge_split_test 的同名案例，金额换到整数分
  it("splits the gross into principal and surcharge using session metadata", () => {
    expect(
      splitSurchargedCapture(103900, {
        invoice_id: "inv",
        [PRINCIPAL_AMOUNT_METADATA_KEY]: "100000",
        [SURCHARGE_AMOUNT_METADATA_KEY]: "3900",
      }),
    ).toEqual({ principalCents: 100000, surchargeCents: 3900 });
  });

  it("treats a capture with no surcharge metadata exactly as before (regression anchor)", () => {
    // 本切片上线前创建的所有 session 走这条路：gross 就是 principal，没有费
    expect(splitSurchargedCapture(100000, { invoice_id: "inv" })).toEqual({
      principalCents: 100000,
      surchargeCents: null,
    });
    expect(splitSurchargedCapture(100000, {})).toEqual({ principalCents: 100000, surchargeCents: null });
  });

  it("refuses to bank a capture whose split does not sum to the amount received", () => {
    // 费率行可被管理员改：报出的价与实扣额可能真的不一致——一个数字是错的而
    // 这里无法分辨是哪个，什么都不入账
    expect(
      splitSurchargedCapture(103900, {
        [PRINCIPAL_AMOUNT_METADATA_KEY]: "100000",
        [SURCHARGE_AMOUNT_METADATA_KEY]: "3000",
      }),
    ).toBeNull();
  });

  it("refuses a half-declared split (deriving the missing half would prove nothing)", () => {
    expect(splitSurchargedCapture(103900, { [SURCHARGE_AMOUNT_METADATA_KEY]: "3900" })).toBeNull();
    expect(splitSurchargedCapture(103900, { [PRINCIPAL_AMOUNT_METADATA_KEY]: "100000" })).toBeNull();
  });

  it("refuses a surcharge that is not a positive whole number of cents", () => {
    for (const bad of ["0", "-100", "3900.5", "", "lots", null]) {
      expect(
        splitSurchargedCapture(103900, {
          [PRINCIPAL_AMOUNT_METADATA_KEY]: "100000",
          [SURCHARGE_AMOUNT_METADATA_KEY]: bad,
        }),
      ).toBeNull();
    }
    for (const bad of ["0", "-100", "100000.5", "", "lots", null]) {
      expect(
        splitSurchargedCapture(103900, {
          [PRINCIPAL_AMOUNT_METADATA_KEY]: bad,
          [SURCHARGE_AMOUNT_METADATA_KEY]: "3900",
        }),
      ).toBeNull();
    }
  });
});

describe("normalizeStripeEvent (#193)", () => {
  const invoiceId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  function paidEvent(object: Record<string, unknown>, type = "checkout.session.completed", created = 1_760_000_000): unknown {
    return {
      id: "evt_1",
      type,
      created,
      data: { object },
    };
  }

  it("normalizes a card checkout completion: intent id wins, amount received wins", () => {
    const event = normalizeStripeEvent(
      paidEvent({
        id: "cs_123",
        payment_intent: "pi_abc",
        amount_total: 150000,
        amount_received: 150000,
        metadata: { invoice_id: invoiceId },
      }),
    );
    expect(event).toMatchObject({
      kind: "payment",
      externalId: "pi_abc",
      amountCents: 150000,
      invoiceId,
      invoiceIdInvalid: false,
    });
  });

  it("falls back to the session id when no payment intent exists (async bank debit)", () => {
    const event = normalizeStripeEvent(
      paidEvent({ id: "cs_456", amount_total: 90000 }, "checkout.session.async_payment_succeeded"),
    );
    expect(event).toMatchObject({ kind: "payment", externalId: "cs_456", amountCents: 90000, invoiceId: null });
  });

  it("prefers amount_received when the two amounts disagree", () => {
    const event = normalizeStripeEvent(paidEvent({ id: "pi_1", amount_total: 90000, amount_received: 85000 }));
    expect(event).toMatchObject({ kind: "payment", amountCents: 85000 });
  });

  it("treats completed + succeeded for the same intent as the same idempotency key", () => {
    const object = { id: "cs_1", payment_intent: "pi_x", amount_total: 100 };
    const first = normalizeStripeEvent(paidEvent(object, "checkout.session.completed"));
    const second = normalizeStripeEvent(paidEvent(object, "payment_intent.succeeded"));
    expect(first.kind === "payment" && second.kind === "payment" && first.externalId === second.externalId).toBe(
      true,
    );
  });

  it("ignores non-money events (failures, refunds, everything else)", () => {
    expect(
      normalizeStripeEvent(paidEvent({ id: "cs_1" }, "checkout.session.async_payment_failed")).kind,
    ).toBe("ignored");
    expect(normalizeStripeEvent(paidEvent({ id: "pi_1" }, "payment_intent.payment_failed")).kind).toBe("ignored");
    expect(normalizeStripeEvent(paidEvent({ id: "re_1" }, "refund.created")).kind).toBe("ignored");
    expect(normalizeStripeEvent(paidEvent({ id: "cs_1" }, "customer.subscription.updated")).kind).toBe("ignored");
  });

  it("refuses to confirm a paid event whose amount is unreadable (fail loud, retry)", () => {
    expect(normalizeStripeEvent(paidEvent({ id: "cs_1" })).kind).toBe("unparsable");
    expect(
      normalizeStripeEvent(paidEvent({ id: "cs_1", amount_total: 12.5 })).kind,
    ).toBe("unparsable");
    expect(
      normalizeStripeEvent(paidEvent({ id: "cs_1", amount_total: -5 })).kind,
    ).toBe("unparsable");
  });

  it("flags a metadata invoice_id that is not a uuid; absent metadata is just unclaimed", () => {
    const corrupt = normalizeStripeEvent(
      paidEvent({ id: "cs_1", amount_total: 100, metadata: { invoice_id: "not-a-uuid" } }),
    );
    expect(corrupt).toMatchObject({ kind: "payment", invoiceId: null, invoiceIdInvalid: true });
    const absent = normalizeStripeEvent(paidEvent({ id: "cs_1", amount_total: 100 }));
    expect(absent).toMatchObject({ kind: "payment", invoiceId: null, invoiceIdInvalid: false });
  });

  it("books the principal of a surcharged capture and carries the fee beside it", () => {
    // Stripe 线格式：metadata 值是字符串
    const event = normalizeStripeEvent(
      paidEvent({
        id: "cs_1",
        payment_intent: "pi_x",
        amount_total: 155850,
        amount_received: 155850,
        metadata: {
          invoice_id: invoiceId,
          principal_amount_cents: "150000",
          surcharge_amount_cents: "5850",
        },
      }),
    );
    expect(event).toMatchObject({
      kind: "payment",
      amountCents: 150000,
      surchargeCents: 5850,
      invoiceId,
    });
  });

  it("refuses a surcharged event whose split does not reconcile (502, redeliver)", () => {
    const mismatched = normalizeStripeEvent(
      paidEvent({
        id: "cs_1",
        amount_total: 155000,
        metadata: { principal_amount_cents: "150000", surcharge_amount_cents: "5850" },
      }),
    );
    expect(mismatched.kind).toBe("unparsable");
    const halfDeclared = normalizeStripeEvent(
      paidEvent({ id: "cs_1", amount_total: 155850, metadata: { surcharge_amount_cents: "5850" } }),
    );
    expect(halfDeclared.kind).toBe("unparsable");
  });

  it("clamps a future event timestamp down to now (received_at never lies ahead)", () => {
    vi.useFakeTimers({ now: 1_760_000_500_000 }); // 事件「时刻」在 fake now 之后 500 秒——钟差场景
    try {
      const event = normalizeStripeEvent(
        paidEvent({ id: "cs_1", amount_total: 100 }, "checkout.session.completed", 1_760_001_000),
      );
      expect(event.kind === "payment" && event.receivedAt.getTime()).toBe(1_760_000_500_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createStripeGateway (#193)", () => {
  const baseInput = {
    invoiceId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    invoiceNumber: "INV-0001",
    amountCents: 150000,
    currency: "USD",
    successUrl: "https://app.example.com/portal/invoices/x?stripe=success",
    cancelUrl: "https://app.example.com/portal/invoices/x?stripe=cancel",
  };

  function fetcherResponding(status: number, payload: unknown): { fetcher: typeof fetch; calls: Request[] } {
    const calls: Request[] = [];
    const fetcher = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push(new Request(input, init));
      return Promise.resolve(new Response(JSON.stringify(payload), { status }));
    }) as typeof fetch;
    return { fetcher, calls };
  }

  it("sends form-encoded server-computed params with the secret key and returns the session", async () => {
    const { fetcher, calls } = fetcherResponding(200, { id: "cs_789", url: "https://checkout.stripe.com/c/pay/cs_789" });
    const gateway = createStripeGateway({ secretKey: "sk_test_x", fetcher });
    const session = await gateway.createCheckoutSession(baseInput);
    expect(session).toEqual({ id: "cs_789", url: "https://checkout.stripe.com/c/pay/cs_789" });
    const request = calls[0];
    if (request === undefined) throw new Error("gateway made no request");
    expect(request.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(request.headers.get("authorization")).toBe("Bearer sk_test_x");
    const form = new URLSearchParams(await request.text());
    expect(form.get("mode")).toBe("payment");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("150000");
    expect(form.get("line_items[0][price_data][currency]")).toBe("usd");
    expect(form.get("metadata[invoice_id]")).toBe(baseInput.invoiceId);
    expect(form.get("client_reference_id")).toBe(baseInput.invoiceId);
  });

  it("charges principal + surcharge and rides the split on session metadata", async () => {
    const { fetcher, calls } = fetcherResponding(200, { id: "cs_sur", url: "https://checkout.stripe.com/c/pay/cs_sur" });
    const gateway = createStripeGateway({ secretKey: "sk_test_x", fetcher });
    await gateway.createCheckoutSession({ ...baseInput, surchargeCents: 5850 });
    const request = calls[0];
    if (request === undefined) throw new Error("gateway made no request");
    const form = new URLSearchParams(await request.text());
    // 客户被实扣 principal + fee；拆分进 metadata 供 webhook 对账
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("155850");
    expect(form.get("metadata[principal_amount_cents]")).toBe("150000");
    expect(form.get("metadata[surcharge_amount_cents]")).toBe("5850");
  });

  it("omits the surcharge keys for an ordinary session (0 = no surcharge, not a zero fee)", async () => {
    const { fetcher, calls } = fetcherResponding(200, { id: "cs_plain", url: "https://checkout.stripe.com/c/pay/cs_plain" });
    const gateway = createStripeGateway({ secretKey: "sk_test_x", fetcher });
    await gateway.createCheckoutSession(baseInput);
    const request = calls[0];
    if (request === undefined) throw new Error("gateway made no request");
    const form = new URLSearchParams(await request.text());
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("150000");
    expect(form.get("metadata[principal_amount_cents]")).toBeNull();
    expect(form.get("metadata[surcharge_amount_cents]")).toBeNull();
  });

  it("throws a gateway error on a non-2xx (details stay in the log, not the type)", async () => {
    const { fetcher } = fetcherResponding(402, { error: { message: "card_declined" } });
    const gateway = createStripeGateway({ secretKey: "sk_test_x", fetcher });
    await expect(gateway.createCheckoutSession(baseInput)).rejects.toBeInstanceOf(StripeGatewayError);
  });

  it("throws a gateway error when the response shape is unexpected", async () => {
    const { fetcher } = fetcherResponding(200, { unexpected: true });
    const gateway = createStripeGateway({ secretKey: "sk_test_x", fetcher });
    await expect(gateway.createCheckoutSession(baseInput)).rejects.toBeInstanceOf(StripeGatewayError);
  });
});
