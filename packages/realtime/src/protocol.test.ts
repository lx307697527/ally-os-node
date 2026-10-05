import { describe, expect, it } from "vitest";
import {
  CHANNEL_MAX_LENGTH,
  NOTIFICATIONS_CHANGED_EVENT,
  USER_CHANNEL_PREFIX,
  channelSchema,
  isUserChannel,
  userChannel,
} from "./protocol.ts";

describe("user channels (#110 slice 2)", () => {
  it("userChannel 拼接前缀；isUserChannel 只认这个前缀", () => {
    const id = "8f3a0000-0000-4000-8000-000000000001";
    expect(userChannel(id)).toBe(`${USER_CHANNEL_PREFIX}${id}`);
    expect(isUserChannel(userChannel(id))).toBe(true);
    expect(isUserChannel("presence:doc-42")).toBe(false);
    expect(isUserChannel("userx:1")).toBe(false);
  });

  it("user: + uuid 满足频道名规则（uuid 的连字符在白名单里）", () => {
    const parsed = channelSchema.safeParse(userChannel("8f3a0000-0000-4000-8000-000000000001"));
    expect(parsed.success).toBe(true);
    // 长度上限对拼接结果同样生效
    const long = userChannel("x".repeat(CHANNEL_MAX_LENGTH));
    expect(channelSchema.safeParse(long).success).toBe(false);
  });

  it("notifications.changed 是知名事件常量，客户端与服务端引用同一份", () => {
    expect(NOTIFICATIONS_CHANGED_EVENT).toBe("notifications.changed");
  });
});
