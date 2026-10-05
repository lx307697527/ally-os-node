import { describe, expect, it } from "vitest";
import { USER_CHANNEL_PREFIX, isUserChannel, userChannel } from "@ally/realtime";
import { canSubscribeChannel } from "./channels.ts";

describe("canSubscribeChannel (#110 slice 2)", () => {
  const me = "8f3a0000-0000-4000-8000-000000000001";

  it("user: 频道只有本人能订阅：自己的放行，别人的拒绝", () => {
    expect(canSubscribeChannel(userChannel(me), me)).toBe(true);
    expect(
      canSubscribeChannel(userChannel("8f3a0000-0000-4000-8000-000000000002"), me),
    ).toBe(false);
  });

  it("前缀是整体匹配：user: 后面必须原样等于 userId，不许前后缀拼接", () => {
    expect(canSubscribeChannel(`${USER_CHANNEL_PREFIX}${me}-extra`, me)).toBe(false);
    expect(canSubscribeChannel(`${USER_CHANNEL_PREFIX}x${me}`, me)).toBe(false);
  });

  it("非 user: 频道沿用「登录即可订阅」（#30 原行为）", () => {
    expect(canSubscribeChannel("notes:1", me)).toBe(true);
    expect(canSubscribeChannel("presence:doc-42", me)).toBe(true);
    expect(canSubscribeChannel("userish:1", me)).toBe(true);
  });

  it("isUserChannel 只认 user: 前缀", () => {
    expect(isUserChannel("user:abc")).toBe(true);
    expect(isUserChannel("users:abc")).toBe(false);
    expect(isUserChannel("presence:room")).toBe(false);
  });
});
