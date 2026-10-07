---
session_id: hand-written-110-comment-attachments
branch: feat/110-comment-attachments
date: 2026-10-07
reason: issue-110
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/110-comment-attachments — 2026-10-07

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#110(评论、@提及、通知与活动流)。切片 1–5 已合并
  (#262–#266),本切片做剩余清单第一条「附件(等 @ally/storage)」。
  PR 正文写 Part of #110(阶段笔记+AI 摘要等剩余项不受影响,严禁 Closes)。
- **前置收尾(第 0 步)**:无 open PR、无残留 worktree、主检出干净;
  origin/main 顶端 1d23bd0(#297)即基线。
- **选题**:①优先续做 issue 评论里的未完成切片。#224/#226/#233/#221/#220 的
  剩余项多数在等依赖(SMS 通道、#118、#206、属主域)或已裁「随第一个真实需求」,
  #110 的附件切片阻塞恰好随 @ally/storage 包(packages/storage,S3 协议 +
  签名 URL,env 已备)落地而解除——按续做优先选它。claim 一次成功。
- **老系统参考(只读)**:老系统这一代没有可移植的评论(切片 4 已裁
  greenfield),但附件有两个可引先例:询价附件(私有桶 + 签名 URL + BUG-325
  桶内孤儿 + BUG-123 preview/download 之辨)与反馈附件(≤3 张 ≤5MiB、孤儿
  回收 cron)。本切片的准入数字与生命周期裁决都从这两个先例推导。
- **数据库**:本地 postgres 可用(5432 端口活着),verify 全程带
  DATABASE_URL(无 skip)。

### 本切片改动的文件

- `packages/db/src/schema.ts` + 迁移 0028:`comment_attachments`(expand-only
  ——id/commentId CASCADE/fileName/contentType/sizeBytes/storageKey 唯一索引/
  uploadedBy/createdAt)。
- `packages/storage`:Storage 接口补 `delete(key)`(生命周期清理的最低要求),
  DeleteObjectCommand 过同一份 assertSafeKey;测试 +1。
- `apps/api/src/routes/comments.ts`:四个附件端点(list / author 上传
  multipart / 按需签名 URL / author 摘除)+ 列表读法一次 in 查询水合附件 +
  评论删除补字节面清理。上传顺序 = 先落桶后记账(单事务锁评论行重数名额),
  记账失败逐 key 尽力删。审计 `comment.attachment_added/removed`,detail 带
  subject 引用,活动流投影零接线自动收录。
- `apps/api/src/app.ts` + `index.ts`:AppDeps 增必选 `storage`(DI,测试注入
  内存假实现),index.ts 用 createS3Storage 从 env 装配;apps/api 依赖表加
  `@ally/storage: workspace:*`。
- `apps/api/src/routes/registry.ts`:4 条新路由的 auth 声明(session,行属门
  在路由内,无新权限点);25 个测试文件的 createApp 补 storage loud fake
  (AppDeps 必选依赖的既有纪律,notifyUsers 先例)。
- Web:`comments-client.ts`(附件行 schema 无 URL 字段;attach multipart 不
  手写 content-type、400 的 code 走 zod enum 收口;url/remove 两个适配器)+
  `TaskDetail.tsx`(附件列表 + Download 人人可见、Attach/Remove 只在
  `mine` 行,上传中态、逐行错误文案,rejectionSentence 把服务端 code 翻译成
  句子,anchor.download 恢复原文件名)。
- 测试(+20,零 skip):API 集成 7(字节落桶 + 键形状、签名 URL 门与
  404 反探测、作者动词 403/404、封闭词表五连拒、每评论 5 个上限、摘除三清、
  评论删除带走对象)、纯函数 2、client 3、页面源码纪律 7;storage delete 1。
- `docs/comments.md` 新建(评论内核 + 附件面全文);`docs/audit.md` 词表补
  attachment 两动词。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 109 文件 / 998 测试
(基线 108/978;lint/typecheck 含于 verify)。

## 判断层(本次的关键判断与踩的坑)

1. **附件挂评论行,不挂 subject。** 表可以直接引用 subject_type/subject_id
   (与 follows 同形态),但那样「谁能删」「这是谁的文件」都要重新裁决一遍;
   挂评论行则行属(作者)、可见性(subject 门)、生命周期(评论删则行灭)
   三件全是现成裁决的复用,新表自己只欠「字节放哪、怎么下载」两件事。内核
   机制的价值就在后续消费者零裁决。
2. **先落桶后记账,把老 BUG-325 的孤儿问题判成「罕见且不可见」。** 顺序反过来
   (先记账后落桶)失败模式是「看得见的死附件行」——列表里挂着、点下载 404,
   每个读者都要处理第三态;先落桶的失败模式只是桶里无人引用的字节,不可见、
   不伤人,记账失败路径逐 key 尽力删(packages/storage 补的 delete)后残余
   近乎为零。回收 cron 不预建:为不存在的规模先立机制,重演老系统 38 个
   触发器的老路。
3. **签名 URL 按需铸,不进列表响应。** 列表会进日志、进 react-query 缓存、
   进 devtools;15 分钟时效的 URL 跟着这些载体跑等于没有时效。多一次点击
   换「泄露面 = 一次点击」,这是 BUG-123 preview/download 之辨在新形态下的
   收敛:URL 是动词的产物,不是名词的属性。
4. **准入数字全部显式拒绝式收口,错误带 code。** 老系统的桶准入(≤3 张
   ≤5MiB)散在 RPC 里;新面把类型白名单/大小/数量/文件名做成 400 + code 的
   封闭词表,web 端用 zod enum 解析同一个词表再翻译成句子——服务端唯一权威,
   客户端只负责把 `file_too_large` 说成人话。数量名额在事务里锁评论行重数:
   并发的两个 attach 各自数出的余量不互相踩,这是行锁读旧值纪律的又一次
   直接套用(#224 update_field 同裁)。
5. **坑:trailing 表——`comment_attachments` 进了 schema,所有 TRUNCATE
   comments 的测试文件都得同句带上它**(FK 拒绝单独 truncate,0A000)。
   comments.test 自己先撞,activity/follows 跟着补;凡是 truncate comments
   的地方都是本切片的隐藏消费者,verify 全绿之前一个都跑不掉。
6. **坑:25 个测试文件手拼 createApp deps,没有共享工厂。** 加必选依赖就是
   25 处机械补 fake;python 正则批量补之后 auth.test.ts 仍然漏网——它的
   createApp 是箭头函数返回值、缩进格式不同,正则没咬住,typecheck 兜住了。
   教训:批量改动的正确性靠 typecheck 收口,不靠「正则应该都咬住了」。
7. **坑:label 包 button 打不开文件选择器。** 第一版把 Attach 按钮塞进
   `<label>` 想复用浏览器激活行为——button 是交互内容,label 的激活被吞;
   且本仓库 Button 组件恒渲染 `<button>` 没有 as prop。改成每行一个
   sr-only input + ref Map,行内按钮 onClick 显式 `.click()`,可测可读。
