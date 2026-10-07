import { describe, expect, it, vi } from "vitest";
import type { Fetcher } from "./paypal.ts";
import {
  centsToPayPalAmount,
  createPayPalGateway,
  createPayPalWebhookVerifier,
  normalizePayPalEvent,
  parseCustomId,
  payPalAmountToCents,
  PayPalGatewayError,
  PAYPAL_API_BASE_DEFAULT,
} from "./paypal.ts";
import {
  PRINCIPAL_AMOUNT_METADATA_KEY,
  SURCHARGE_AMOUNT_METADATA_KEY,
} from "./surcharge.ts";

/**
 * PayPal 渠道内核的单元面（#193）：custom_id 载体解析、金额精确换算、事件归一、
 * 订单网关与活体验签（fetch 注入假实现）。全部纯函数 + 注入 fetch，无 DB 无网络。
 * 集成面（真实 HTTP 形状 → 记账 → 审计）在 routes/paypal.test.ts。
 */

/** 构造按 URL 分流的假 PayPal API；每条轨道可编程返回 */
function fakePayPalApi(overrides: {
  tokenStatus?: number;
  tokenBody?: unknown;
  verifyStatus?: number;
  verifyBody?: unknown;
  orderStatus?: number;
  orderBody?: unknown;
  captureStatus?: number;
  captureBody?: unknown;
} = {}): { fetcher: Fetcher; calls: { url: string; init?: RequestInit | undefined }[] } {
  const calls: { url: string; init?: RequestInit | undefined }[] = [];
  const fetcher = vi.fn(((url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: href, init });
    const json = (body: unknown, status: number) =>
      new Response(body === undefined ? null : JSON.stringify(body), { status });
    if (href.includes("/v1/oauth2/token")) {
      return json(overrides.tokenBody ?? { access_token: "token-1" }, overrides.tokenStatus ?? 200);
    }
    if (href.includes("/v1/notifications/verify-webhook-signature")) {
      return json(
        overrides.verifyBody ?? { verification_status: "SUCCESS" },
        overrides.verifyStatus ?? 200,
      );
    }
    if (/\/v2\/checkout\/orders\/[^/]+\/capture$/.test(href)) {
      return json(overrides.captureBody ?? {}, overrides.captureStatus ?? 201);
    }
    if (href.includes("/v2/checkout/orders")) {
      return json(
        overrides.orderBody ?? {
          id: "ORDER-1",
          links: [{ rel: "self", href: "https://api.example.com/v2/checkout/orders/ORDER-1" }, { rel: "approve", href: "https://www.paypal.com/checkoutnow?token=ORDER-1" }],
        },
        overrides.orderStatus ?? 201,
      );
    }
    return new Response(null, { status: 404 });
  }) as unknown as Fetcher);
  return { fetcher, calls };
}
const CREDS = { clientId: "cid", clientSecret: "secret" };

describe("payPalAmountToCents (#193)", () => {
  it("parses decimal strings by exact integer math (no float multiply)", () => {
    expect(payPalAmountToCents("1500.00")).toBe(150000);
    expect(payPalAmountToCents("0.29")).toBe(29); // 0.29 * 100 = 28.999… in float
    expect(payPalAmountToCents("8.45")).toBe(845); // 8.45 * 100 = 844.999… in float
    expect(payPalAmountToCents("1500")).toBe(150000); // 0-decimal currencies
    expect(payPalAmountToCents(" 12.30 ")).toBe(1230);
  });

  it("refuses shapes that are not 0–2 decimal non-negative amounts", () => {
    expect(payPalAmountToCents("12.345")).toBeNull();
    expect(payPalAmountToCents("-5.00")).toBeNull();
    expect(payPalAmountToCents("abc")).toBeNull();
    expect(payPalAmountToCents("")).toBeNull();
    expect(payPalAmountToCents("1,500.00")).toBeNull();
    expect(payPalAmountToCents("1e3")).toBeNull();
  });

  it("round-trips through centsToPayPalAmount exactly", () => {
    for (const cents of [0, 1, 29, 5850, 155850, 123456789]) {
      expect(payPalAmountToCents(centsToPayPalAmount(cents))).toBe(cents);
    }
    expect(centsToPayPalAmount(155850)).toBe("1558.50");
    expect(centsToPayPalAmount(5)).toBe("0.05");
  });
});

describe("parseCustomId (#193 carrier)", () => {
  it("reads the bare form as an anchor with an empty declaration", () => {
    const parsed = parseCustomId("0c0ffee0-0000-4000-8000-000000000001");
    expect(parsed).toEqual({
      invoiceId: "0c0ffee0-0000-4000-8000-000000000001",
      declaration: {},
    });
  });

  it("reads the surcharge declaration into the shared metadata keys", () => {
    const parsed = parseCustomId("inv-1;p=150000;s=5850");
    expect(parsed?.invoiceId).toBe("inv-1");
    expect(parsed?.declaration).toEqual({
      [PRINCIPAL_AMOUNT_METADATA_KEY]: "150000",
      [SURCHARGE_AMOUNT_METADATA_KEY]: "5850",
    });
  });

  it("refuses half declarations, repeated segments and empty carriers", () => {
    expect(parseCustomId("inv-1;p=150000")).toBeNull(); // 半申报
    expect(parseCustomId("inv-1;s=5850")).toBeNull();
    expect(parseCustomId("inv-1;p=1;p=2;s=3")).toBeNull(); // 重复 = 歧义
    expect(parseCustomId("")).toBeNull();
    expect(parseCustomId("   ")).toBeNull();
    expect(parseCustomId(";p=1;s=2")).toBeNull();
  });
});

describe("normalizePayPalEvent (#193)", () => {
  const captureEvent = (resource: unknown, eventType = "PAYMENT.CAPTURE.COMPLETED"): unknown => ({
    id: "WH-1",
    event_type: eventType,
    resource,
  });

  it("normalizes a completed capture with a bare custom_id (gross = principal)", () => {
    const event = normalizePayPalEvent(
      captureEvent({
        id: "CAP-1",
        amount: { value: "1500.00", currency_code: "USD" },
        custom_id: "0c0ffee0-0000-4000-8000-000000000001",
        create_time: "2026-10-08T10:00:00Z",
      }),
    );
    expect(event).toMatchObject({
      kind: "payment",
      externalId: "CAP-1",
      amountCents: 150000,
      surchargeCents: null,
      invoiceId: "0c0ffee0-0000-4000-8000-000000000001",
      invoiceIdInvalid: false,
    });
  });

  it("splits a surcharged capture through the shared reconciliation", () => {
    const event = normalizePayPalEvent(
      captureEvent({
        id: "CAP-2",
        amount: { value: "1558.50" },
        custom_id: "0c0ffee0-0000-4000-8000-000000000001;p=150000;s=5850",
      }),
    );
    expect(event).toMatchObject({
      kind: "payment",
      amountCents: 150000,
      surchargeCents: 5850,
    });
  });

  it("answers a capture without our anchor as an unclaimed payment (200 ack path)", () => {
    const event = normalizePayPalEvent(
      captureEvent({ id: "CAP-3", amount: { value: "10.00" } }),
    );
    expect(event).toMatchObject({ kind: "payment", invoiceId: null, invoiceIdInvalid: false });
  });

  it("refuses present-but-invalid carriers loudly (unparsable → 502)", () => {
    // 声明拆不开（半申报 / 总额对不上）
    expect(
      normalizePayPalEvent(captureEvent({ id: "CAP-4", amount: { value: "10.00" }, custom_id: "inv;p=1" })).kind,
    ).toBe("unparsable");
    expect(
      normalizePayPalEvent(
        captureEvent({ id: "CAP-5", amount: { value: "10.00" }, custom_id: "inv;p=7;s=3" }),
      ).kind,
    ).toBe("unparsable");
    // 金额读不出可信整数分
    expect(
      normalizePayPalEvent(captureEvent({ id: "CAP-6", amount: { value: "12.345" } })).kind,
    ).toBe("unparsable");
    // invoice id 不是 UUID（有人在渠道侧动过载体）
    const invalid = normalizePayPalEvent(
      captureEvent({ id: "CAP-7", amount: { value: "10.00" }, custom_id: "not-a-uuid" }),
    );
    expect(invalid).toMatchObject({ kind: "payment", invoiceId: null, invoiceIdInvalid: true });
  });

  it("clamps a future create_time to now and survives a missing one", () => {
    const future = normalizePayPalEvent(
      captureEvent({ id: "CAP-8", amount: { value: "1.00" }, create_time: "2036-01-01T00:00:00Z" }),
    );
    if (future.kind !== "payment") throw new Error("expected payment");
    expect(future.receivedAt.getTime()).toBeLessThanOrEqual(Date.now());

    const noTime = normalizePayPalEvent(captureEvent({ id: "CAP-9", amount: { value: "1.00" } }));
    if (noTime.kind !== "payment") throw new Error("expected payment");
    expect(noTime.receivedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("normalizes an approved order into a capture request with our anchor", () => {
    const event = normalizePayPalEvent(
      captureEvent(
        {
          id: "ORDER-1",
          purchase_units: [{ custom_id: "0c0ffee0-0000-4000-8000-000000000001;p=150000;s=5850" }],
        },
        "CHECKOUT.ORDER.APPROVED",
      ),
    );
    expect(event).toEqual({
      kind: "capture_request",
      orderId: "ORDER-1",
      invoiceId: "0c0ffee0-0000-4000-8000-000000000001",
    });
  });

  it("answers approved orders we cannot anchor as capture requests without an invoice", () => {
    // 第三方订单：无 purchase_units / 无 custom_id / 载体不认识 —— 都不 capture
    for (const resource of [
      { id: "ORDER-2" },
      { id: "ORDER-3", purchase_units: [{ amount: { value: "1.00" } }] },
      { id: "ORDER-4", purchase_units: [{ custom_id: "junk;p=1" }] },
      { id: "ORDER-5", purchase_units: [{ custom_id: "not-a-uuid" }] },
    ]) {
      const event = normalizePayPalEvent(captureEvent(resource, "CHECKOUT.ORDER.APPROVED"));
      expect(event).toMatchObject({ kind: "capture_request", invoiceId: null });
    }
  });

  it("ignores refunds, reversals, declines and unknown event types (200 ack)", () => {
    for (const eventType of [
      "PAYMENT.CAPTURE.REFUNDED",
      "PAYMENT.CAPTURE.REVERSED",
      "PAYMENT.CAPTURE.DECLINED",
      "PAYMENT.CAPTURE.DENIED",
      "CHECKOUT.ORDER.COMPLETED",
      "CUSTOMER.DISPUTE.CREATED",
    ]) {
      expect(normalizePayPalEvent(captureEvent({ id: "X" }, eventType)).kind).toBe("ignored");
    }
  });

  it("refuses an unparsable envelope", () => {
    expect(normalizePayPalEvent({}).kind).toBe("unparsable");
    expect(normalizePayPalEvent({ event_type: "" }).kind).toBe("unparsable");
    expect(normalizePayPalEvent({ resource: {} }).kind).toBe("unparsable");
    expect(normalizePayPalEvent("not an object").kind).toBe("unparsable");
    expect(normalizePayPalEvent(undefined).kind).toBe("unparsable");
  });
});

describe("createPayPalGateway (#193)", () => {
  const ORDER_INPUT = {
    invoiceId: "0c0ffee0-0000-4000-8000-000000000001",
    invoiceNumber: "INV-0001",
    amountCents: 150000,
    currency: "USD",
    returnUrl: "https://app.example.com/portal/invoices/x?paypal=return",
    cancelUrl: "https://app.example.com/portal/invoices/x?paypal=cancel",
  };

  it("creates an order with the gross in the amount and a bare custom_id (no surcharge)", async () => {
    const api = fakePayPalApi();
    const gateway = createPayPalGateway({ ...CREDS, fetcher: api.fetcher });
    const order = await gateway.createOrder(ORDER_INPUT);
    expect(order).toEqual({ id: "ORDER-1", approveUrl: "https://www.paypal.com/checkoutnow?token=ORDER-1" });

    const orderCall = api.calls.find((call) => call.url.includes("/v2/checkout/orders"));
    if (orderCall === undefined) throw new Error("order create not called");
    const body = JSON.parse((orderCall.init?.body) as string) as {
      intent: string;
      purchase_units: { amount: { currency_code: string; value: string }; custom_id: string }[];
      application_context: { return_url: string; cancel_url: string };
    };
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units).toHaveLength(1);
    expect(body.purchase_units[0]?.amount).toEqual({ currency_code: "USD", value: "1500.00" });
    expect(body.purchase_units[0]?.custom_id).toBe(ORDER_INPUT.invoiceId); // 裸形式
    expect(body.application_context.return_url).toBe(ORDER_INPUT.returnUrl);

    // token 走 client-credentials Basic 认证
    const tokenCall = api.calls[0];
    expect(tokenCall?.url).toBe(`${PAYPAL_API_BASE_DEFAULT}/v1/oauth2/token`);
    const tokenHeaders = tokenCall?.init?.headers as Record<string, string> | undefined;
    expect(tokenHeaders?.authorization).toMatch(/^Basic /);
    expect((tokenCall?.init?.body) as string).toBe("grant_type=client_credentials");
  });

  it("carries the surcharge declaration on custom_id and charges the gross", async () => {
    const api = fakePayPalApi();
    const gateway = createPayPalGateway({ ...CREDS, fetcher: api.fetcher });
    await gateway.createOrder({ ...ORDER_INPUT, amountCents: 150000, surchargeCents: 5850 });
    const orderCall = api.calls.find((call) => call.url.includes("/v2/checkout/orders"));
    const body = JSON.parse((orderCall?.init?.body) as string) as {
      purchase_units: { amount: { value: string }; custom_id: string }[];
    };
    expect(body.purchase_units[0]?.amount.value).toBe("1558.50"); // 实扣额
    expect(body.purchase_units[0]?.custom_id).toBe(`${ORDER_INPUT.invoiceId};p=150000;s=5850`);
  });

  it("fails closed on a failed token, a bad order response, or a missing approve link", async () => {
    const noToken = fakePayPalApi({ tokenStatus: 500 });
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: noToken.fetcher }).createOrder(ORDER_INPUT),
    ).rejects.toBeInstanceOf(PayPalGatewayError);

    const badShape = fakePayPalApi({ orderBody: { id: "ORDER-1" } }); // 缺 links
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: badShape.fetcher }).createOrder(ORDER_INPUT),
    ).rejects.toBeInstanceOf(PayPalGatewayError);

    const noApprove = fakePayPalApi({
      orderBody: { id: "ORDER-1", links: [{ rel: "self", href: "https://x" }] },
    });
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: noApprove.fetcher }).createOrder(ORDER_INPUT),
    ).rejects.toBeInstanceOf(PayPalGatewayError);

    const httpError = fakePayPalApi({ orderStatus: 500 });
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: httpError.fetcher }).createOrder(ORDER_INPUT),
    ).rejects.toBeInstanceOf(PayPalGatewayError);
  });

  it("captures approved orders and recognizes an already-captured replay", async () => {
    const api = fakePayPalApi();
    const gateway = createPayPalGateway({ ...CREDS, fetcher: api.fetcher });
    await expect(gateway.captureOrder("ORDER-1")).resolves.toEqual({ outcome: "completed" });
    const captureCall = api.calls.find((call) => call.url.includes("/capture"));
    expect(captureCall?.url).toBe(`${PAYPAL_API_BASE_DEFAULT}/v2/checkout/orders/ORDER-1/capture`);

    const already = fakePayPalApi({
      captureStatus: 422,
      captureBody: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] },
    });
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: already.fetcher }).captureOrder("ORDER-1"),
    ).resolves.toEqual({ outcome: "already_captured" });

    const other422 = fakePayPalApi({
      captureStatus: 422,
      captureBody: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "NOT_APPROVED" }] },
    });
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: other422.fetcher }).captureOrder("ORDER-1"),
    ).rejects.toBeInstanceOf(PayPalGatewayError);

    const httpError = fakePayPalApi({ captureStatus: 500 });
    await expect(
      createPayPalGateway({ ...CREDS, fetcher: httpError.fetcher }).captureOrder("ORDER-1"),
    ).rejects.toBeInstanceOf(PayPalGatewayError);
  });
});

describe("createPayPalWebhookVerifier (#193)", () => {
  const TRANSMISSION = {
    authAlgo: "SHA256withRSA",
    certUrl: "https://api.paypal.com/v1/notifications/certs/CERT-360",
    transmissionId: "69cd13",
    transmissionSig: "Sdfjklj",
    transmissionTime: "2026-10-08T10:00:00Z",
  };

  it("sends the five transmission fields plus the webhook id and event; accepts SUCCESS", async () => {
    const api = fakePayPalApi();
    const verifier = createPayPalWebhookVerifier({ ...CREDS, webhookId: "WH-ID", fetcher: api.fetcher });
    const event = { event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "CAP-1" } };
    await expect(verifier.verify({ transmission: TRANSMISSION, event })).resolves.toEqual({ ok: true });

    const verifyCall = api.calls.find((call) => call.url.includes("verify-webhook-signature"));
    if (verifyCall === undefined) throw new Error("verify not called");
    const body = JSON.parse((verifyCall.init?.body) as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      auth_algo: TRANSMISSION.authAlgo,
      cert_url: TRANSMISSION.certUrl,
      transmission_id: TRANSMISSION.transmissionId,
      transmission_sig: TRANSMISSION.transmissionSig,
      transmission_time: TRANSMISSION.transmissionTime,
      webhook_id: "WH-ID",
    });
    expect(body.webhook_event).toEqual(event);
  });

  it("fails closed on token failure, verify failure, unexpected shape, and non-SUCCESS", async () => {
    const verifier = (overrides: Parameters<typeof fakePayPalApi>[0]) =>
      createPayPalWebhookVerifier({ ...CREDS, webhookId: "WH-ID", fetcher: fakePayPalApi(overrides).fetcher });
    const input = { transmission: TRANSMISSION, event: {} };

    await expect(verifier({ tokenStatus: 500 }).verify(input)).resolves.toEqual({
      ok: false,
      reason: "token_request_failed",
    });
    await expect(verifier({ verifyStatus: 500 }).verify(input)).resolves.toEqual({
      ok: false,
      reason: "verify_request_failed",
    });
    await expect(verifier({ verifyBody: { nope: true } }).verify(input)).resolves.toEqual({
      ok: false,
      reason: "verify_response_unexpected",
    });
    await expect(verifier({ verifyBody: { verification_status: "FAILURE" } }).verify(input)).resolves.toEqual({
      ok: false,
      reason: "verification_not_success",
    });
  });
});
