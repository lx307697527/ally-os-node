# 实时推送服务（#30）

替代 Supabase Realtime 的自建推送：WebSocket 频道订阅 / 广播 / 在线状态，
实例间用 PG `LISTEN/NOTIFY` 广播，多实例部署不需要额外中间件。

关于老系统：迁移核查发现 ally-os 在 FEAT-388 之后**没有任何 Supabase Realtime
用法**（realtime-js 被构建期 alias 掉、CSP 不放行 wss、有测试围栏），原"14 处
`supabase.channel` 订阅"的前提已过时，老前端实际用 60s 轮询。因此本服务是按
issue #30 的迁移要点新建的基础设施，前端各领域迁移时通过 `@ally/realtime-client`
接入，替换对应模块的轮询。

## 组成

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| 协议 | `packages/realtime/src/protocol.ts` | WS 帧与 NOTIFY 信封的 zod 定义、频道名规则、大小上限 |
| 总线 | `packages/realtime/src/bus.ts` | `RealtimeBus`：发布走 `pg_notify`，专用连接 `LISTEN`，断线自动重连 |
| 中枢 | `apps/api/src/realtime/hub.ts` | `RealtimeHub`：鉴权、订阅表、发布投递、presence 事件，与传输层解耦 |
| presence | `apps/api/src/realtime/presence.ts` | 在线状态落库（`realtime_presence` 表）：TTL 90s、心跳 30s、周期清理 |
| WS 胶水 | `apps/api/src/realtime/ws.ts` | ws upgrade（只放行 `/api/realtime`）、帧顺序、协议层 ping 保活 |
| 客户端 | `packages/realtime-client` | 浏览器/Node SDK：自动重连、重连后恢复订阅并触发 resync |

## user: 私人频道与通知「催」（#110 切片 2）

`user:<userId>` 是保留前缀：**只有本人能订阅自己的 user: 频道**。实现是 hub
新增的可注入 `authorize(channel, userId)`，生产接线为
`apps/api/src/realtime/channels.ts` 的 `canSubscribeChannel`（拒绝回 error
`unauthorized`，订阅表与 presence 都不动；未注入 = #30 的「登录即可订阅任何
频道」）。第一个用途是站内通知的「催」信号：通知落库的事务**提交后**，业务
路由经 `AppDeps.notifyUsers` 对拿到通知的用户各发一次知名事件
`notifications.changed`（`data` 恒为空对象——推送只负责催，数据以 summary
端点的重读为准；发布失败只降级回轮询，不重试、不拖垮业务请求）。

前端消费方（本仓库第一个）：`apps/web/src/shared/lib/notification-live.ts`
每标签页一条 WS，订阅 `user:<id>`，收到催或真重连（attempts>0 的 resync）
即重读 summary；铃铛的 60s 可见轮询**保留为兜底**（at-most-once，丢的催由
轮询补齐）。

浏览器读不到 HttpOnly 的会话 cookie，auth 帧令牌改从 `GET /api/realtime/token`
取：session 门（2FA 强制门内），把调用者**自己会话**的令牌发还给本人——
持有者本就拥有它，不构成提权；客户端只存内存，每次连接尝试重取。

## WS 协议（JSON 文本帧）

客户端 → 服务端：

| 帧 | 说明 |
| --- | --- |
| `{ type: "auth", token }` | 连接后 10s 内必须完成，否则 4401 关闭；token 是会话令牌（见下） |
| `{ type: "subscribe", channel, presence? }` | `presence` 仅在 `presence:` 前缀频道有效 |
| `{ type: "unsubscribe", channel }` | 幂等 |
| `{ type: "publish", channel, event, data }` | 只能发给已订阅频道；经由总线广播（含发送者自己） |
| `{ type: "presence.get", channel, requestId? }` | 拉一次完整名单，回帧带 `requestId` |
| `{ type: "ping" }` | 服务端回 `pong`（心跳之一） |

服务端 → 客户端：`auth.ok` / `subscribed` / `unsubscribed` / `message` /
`presence.state` / `presence.joined` / `presence.left` / `error` / `pong`。

错误只回短代码：`unauthorized`、`bad_frame`、`invalid_channel`、
`not_subscribed`、`too_large`、`publish_failed`；内部细节只进日志。

约束：频道名 `[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}`，presence 频道必须带名字；
NOTIFY payload 上限 6000 字节（PG 硬限 8000），超限发布回 `too_large`。

## 鉴权（#22 已接线）

hub 只认注入的 `authenticate(token) => { userId } | null`。
`apps/api/src/realtime/auth.ts` 的接线（#22 落地后）：

- auth 帧的 `token` 是 **Better Auth 会话令牌**——cookie 里的完整值
  （`token.signature`）或裸 token 都可以；服务端查 `auth_session` 表比对
  （只取第一段，过期即拒绝）。见 `docs/auth.md`。
- 开发/测试保留 `dev:<userId>` 直通令牌，本地联调不依赖登录；
  **生产环境永不放行** `dev:` 前缀。
- 生产环境若没有注入会话校验器（不可能的接线错误），拒绝所有连接并打 warn。

## 多实例与语义

- 发布路径唯一：`pg_notify('ally_realtime', envelope)` → 各实例 LISTEN →
  投给本地订阅者。发布者自己的实例也会收到自己发的消息。
- 语义为 **at-most-once**：实例断线期间的 NOTIFY 会丢。客户端 SDK 重连成功后
  发 `resync`，前端此时重新拉数据——实时推送只负责"催"，不负责补发。
- presence 行的 `last_seen_at` 超过 90s 即不可见；实例崩溃不留幽灵成员。
  名单以数据库为準，任何实例都能回答"谁在线"。

## 保活

- 服务端每 30s 发 ws 协议层 ping，两个周期无 pong 判死并断开（探测半开连接）；
  ALB 空闲超时 300s，30s ping 不会触发。
- 客户端每 30s 发 `{"type":"ping"}`，两个周期无任何消息主动断开重连。

## 验收状态（对应 issue #30）

- [x] 推送服务：频道订阅 / 广播 / 在线状态（WS + PG LISTEN/NOTIFY）
- [x] 两个 API 实例之间消息互通（集成测试：总线级 + 真 WebSocket 端到端）
- [x] 断线自动重连、重连后恢复（客户端 SDK 单测覆盖：重放 auth、重发订阅、resync）
- [ ] "14 处订阅全部替换"：前提已过时（老系统无任何 realtime 用法），随各领域
      前端迁移逐个接入本服务后关闭该条。**进度：第 1 个接入方是通知铃铛**
      （#110 切片 2，推为主、60s 轮询为兜底）
- [x] 连接鉴权换成 #22 的真实会话校验（#22 切片 1 落地：auth 帧带 Better Auth
      会话令牌，服务端查 `auth_session` 校验；`dev:` 令牌仅限非生产）
