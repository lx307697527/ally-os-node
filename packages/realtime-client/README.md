# @ally/realtime-client

Ally OS 实时推送的浏览器 / Node 客户端（配合 `apps/api` 的
`/api/realtime` WebSocket 端点，协议见 `docs/realtime.md`）。

- 自动鉴权（每次连接尝试重新取令牌）、断线自动重连（指数退避 + 抖动）
- 重连成功后自动重发全部订阅（含 presence 自定义状态），并发出一次 `resync`
  ——在这里重新拉取数据；实时推送是 at-most-once，重拉是唯一可靠的补齐方式
- presence 名单本地缓存，事件驱动更新；`requestPresence` 可随时强刷

```ts
import { RealtimeClient } from "@ally/realtime-client";

const client = new RealtimeClient({
  url: "wss://api.example.com/api/realtime",
  getToken: () => session.token, // 每次重连都会调用，令牌可以随时刷新
});

client.on("status", (status) => console.warn("status:", status));
client.on("resync", () => void refetchOpenDocuments());
client.on("message", ({ channel, event, data }) => {
  if (channel === "notes:42" && event === "changed") rerender(data);
});

client.subscribe("notes:42");
client.subscribe("presence:doc-7", { cursor: 120 }); // presence 频道：带自己的状态
client.on("presence.state", ({ channel, members }) => showAvatars(channel, members));

client.connect();
// 发布要在连接 open 之后
client.publish("notes:42", "changed", { title: "new" });
```

测试时注入 `webSocket` 选项即可用假 WebSocket 驱动（见 `src/index.test.ts`）。
