import { isUserChannel, USER_CHANNEL_PREFIX } from "@ally/realtime";

/**
 * 生产接线的频道授权规则（#110 切片 2）：`user:` 前缀是私人频道，只允许
 * 本人订阅 —— 通知的「催」信号虽不带数据，「谁在何时收到通知」本身也是
 * 元信息，不能让登录者互听。其余频道沿用 #30 的「登录即可订阅」；
 * presence 频道（presence:*）有自己的成员可见性语义，不在本规则内。
 *
 * 前缀错配的写法（`user:` 后接别人 id）在这里被拒，hub 回 error
 * unauthorized，订阅表不动。
 */
export function canSubscribeChannel(channel: string, userId: string): boolean {
  if (!isUserChannel(channel)) return true;
  return channel.slice(USER_CHANNEL_PREFIX.length) === userId;
}
