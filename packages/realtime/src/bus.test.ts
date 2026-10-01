import { describe, expect, it, vi } from "vitest";
import { RealtimeBus } from "./bus.ts";
import {
  MAX_NOTIFY_PAYLOAD_BYTES,
  MessageTooLargeError,
  decodeBusEnvelope,
  encodeBusEnvelope,
  type RealtimeBusPayload,
} from "./protocol.ts";

function makeBus(overrides?: { onMessage?: (payload: RealtimeBusPayload) => void }) {
  const queries: { text: string; values: unknown[] }[] = [];
  const received: RealtimeBusPayload[] = [];
  const bus = new RealtimeBus({
    databaseUrl: "postgres://invalid:invalid@127.0.0.1:1/none",
    publishExecutor: {
      query: (text: string, values?: unknown[]) => {
        queries.push({ text, values: values ?? [] });
        return Promise.resolve({});
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as never,
    instanceId: "instance-a",
    onMessage: (payload) => {
      received.push(payload);
      overrides?.onMessage?.(payload);
    },
  });
  return { bus, queries, received };
}

describe("bus envelope codec", () => {
  it("round-trips a message payload", () => {
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: "notes:42",
      event: "created",
      data: { id: 7 },
      senderUserId: "u1",
    };
    const encoded = encodeBusEnvelope(payload, "instance-a");
    expect(typeof encoded).toBe("string");

    const decoded = decodeBusEnvelope(encoded);
    expect(decoded).toEqual({ v: 1, instanceId: "instance-a", payload });
  });

  it("round-trips presence payloads", () => {
    const joined: RealtimeBusPayload = {
      type: "presence.joined",
      channel: "presence:doc-1",
      members: [{ connectionId: "c1", userId: "u1", state: { cursor: 3 } }],
    };
    expect(decodeBusEnvelope(encodeBusEnvelope(joined, "i"))).toMatchObject({ payload: joined });

    const left: RealtimeBusPayload = {
      type: "presence.left",
      channel: "presence:doc-1",
      connectionIds: ["c1", "c2"],
    };
    expect(decodeBusEnvelope(encodeBusEnvelope(left, "i"))).toMatchObject({ payload: left });
  });

  it("rejects oversized payloads with MessageTooLargeError", () => {
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: "notes:42",
      event: "created",
      data: { blob: "x".repeat(MAX_NOTIFY_PAYLOAD_BYTES) },
    };
    expect(() => encodeBusEnvelope(payload, "instance-a")).toThrow(MessageTooLargeError);
  });

  it("returns null for malformed payloads", () => {
    expect(decodeBusEnvelope("not json")).toBeNull();
    expect(decodeBusEnvelope("{}")).toBeNull();
    expect(decodeBusEnvelope(JSON.stringify({ v: 2, instanceId: "i", payload: {} }))).toBeNull();
  });
});

describe("RealtimeBus.publish", () => {
  it("sends pg_notify with the encoded envelope", async () => {
    const { bus, queries } = makeBus();
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: "notes:42",
      event: "created",
      data: { id: 7 },
    };
    await bus.publish(payload);

    expect(queries).toHaveLength(1);
    const query = queries[0];
    expect(query?.text).toBe("select pg_notify($1, $2)");
    expect(query?.values[0]).toBe("ally_realtime");
    expect(decodeBusEnvelope(String(query?.values[1]))?.payload).toEqual(payload);
  });

  it("propagates MessageTooLargeError without querying", async () => {
    const { bus, queries } = makeBus();
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: "c",
      event: "e",
      data: { blob: "x".repeat(MAX_NOTIFY_PAYLOAD_BYTES) },
    };
    await expect(bus.publish(payload)).rejects.toBeInstanceOf(MessageTooLargeError);
    expect(queries).toHaveLength(0);
  });
});

describe("RealtimeBus.dispatch (via notification callback)", () => {
  it("delivers a valid payload to onMessage", () => {
    const { bus, received } = makeBus();
    const payload: RealtimeBusPayload = {
      type: "message",
      channel: "notes:1",
      event: "created",
      data: null,
    };
    bus.handleNotifyPayload(encodeBusEnvelope(payload, "instance-b"));
    expect(received).toEqual([payload]);
  });

  it("drops malformed payloads and keeps the handler safe from throwing consumers", () => {
    const boom = vi.fn(() => {
      throw new Error("handler exploded");
    });
    const { bus, received } = makeBus({ onMessage: boom });

    bus.handleNotifyPayload("garbage");
    bus.handleNotifyPayload(undefined);
    expect(received).toHaveLength(0);

    bus.handleNotifyPayload(
      encodeBusEnvelope({ type: "message", channel: "c", event: "e", data: null }, "i"),
    );
    expect(received).toHaveLength(1);
    expect(boom).toHaveBeenCalledTimes(1);
  });
});
