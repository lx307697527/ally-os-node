---
session_id: hand-written-31-storage-migration
branch: feat/31-storage-migration
date: 2026-10-09
reason: issue-31
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/31-storage-migration — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#31(文件存储迁移 Supabase Storage → S3,phase-1)——切片
  1(文件内核,PR #324)已合并。本切片落**对象迁移脚本**(切片 2):Supabase
  Storage → S3 按原路径批量复制 + 数量对账 + hash 抽样校验(验收第 1 条的执行
  能力)。PR 写 **Part of #31**(执行需双方凭证,随切换窗口跑;12 处老调用点
  替换随各域迁移,见 docs/storage.md 切片地图)。
- **前置收尾(第 0 步)**:fetch --prune;无 open PR(#322/#324/#325/#326 均
  已合并,main 在 86fb97b)。`.claude/worktrees/128-pdf-service` 有 #128 的
  WIP(packages/pdf/、invoice-pdf 路由、0043 migration),租约 HELD 且目录
  8 分钟前有改动——**别的会话正在进行中,不清理不动它**。
- **选题**:优先级 ① 逐个核对进行中 issue:#22 代码侧全就绪(剩余=切换日运维
  步骤 + Google OAuth staging 真实凭据冒烟,全 gated);#23 剩跨租户回归测试
  等 #235/#227;#25 等 CRM;#27 剩余三片全 gated(IP 黑名单等真实滥用场景、
  honeypot 等首个公开表单域);#28 剩 Slack 演练(部署后)+ breadcrumbs(等
  web 控制台交互面);#29 剩余挂 #227/#203/#204;#30 的「① #22 落地后接真实
  会话鉴权」**其实已经落地**(index.ts:156 已注入 createSessionTokenVerifier(db),
  评论过时),剩余只有 ② 随域接入;#32 任务随域登记。→ **唯一非 gated 的进行
  中切片 = #31 的迁移脚本**(执行 gated,脚本本身可写可测)。#33/#34 纯 infra。
  claim #31(前一切片的陈旧租约自动接管)。
- **参考**:老系统 `storage.from(...)` 12 处调用点(feedback-actions 等,桶 +
  桶内路径两段式);docs/storage.md 切片地图(本切片在其上勾掉第二行);#324
  文件内核的 Storage 接口与 head() isNotFound 家法;import-legacy-users CLI
  的家法(dry-run 默认、--apply、报告 stdout/日志 stderr、退出码 0/1/2)。

### 本切片改动的文件

- `packages/storage/src/index.ts`:+ `StorageReader` 接口(get/list)+ 
  `createS3StorageReader`(GetObject 读字节、ListObjectsV2 分页枚举)+
  `validateStoragePrefix`(前缀闸:禁空串/绝对/穿越,允许尾部斜杠)。
  **刻意不加进 Storage 接口**(判断层 2)。
- `apps/api/src/storage-migration/migrate.ts`(新):源/目标端口
  (`StorageMigrationSource`/`MigrationTarget`)+ 编排核心。dry-run 逐对象
  head 报「将会复制/跳过」;apply head 大小一致即跳过(断点续跑)→ 
  download → put,随后自动数量对账 + 确定性抽样 hash 校验;verify 只校验。
  key 映射一次(`keyByPath`)三阶段共用,坏 key 只记一条 key 阶段错误;
  报告逐桶带阶段化错误(list/key/head/download/put/verify);抽样
  mulberry32 种子流 + 池内 splice,同种子同样本,且跳过本桶已报错对象。
- `apps/api/src/storage-migration/supabase-source.ts`(新):Storage REST 源
  (service role 鉴权):`/storage/v1/bucket` 枚举桶、`/object/list` 分页
  (sortBy name asc)+ 目录条目(id=null)深度优先下钻、`/object/{bucket}/…`
  逐段编码下载;zod 校验两个清单响应;**name 的相对/全路径两可形态统一归一化**
  (判断层 9)。
- `apps/api/src/scripts/migrate-storage-to-s3.ts`(新):CLI。env =
  envSchema.pick(S3_*/LOG_LEVEL).extend(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)
  ——**源凭证是脚本私有,不进服务 envSchema 主面,也不进 .env.example**
  (判断层 8);flag --apply/--verify/--bucket/--sample/--seed;报告 JSON 走
  stdout,退出码 0/1/2。
- `packages/storage/src/index.test.ts`:+11(reader 的 key/前缀闸、
  validateStoragePrefix 矩阵)。
- `apps/api/src/storage-migration/migrate.test.ts`(新,19):dry-run 不写/
  计划计数;apply 落点 `<桶名>/<路径>` 字节相等、断点续跑零下载、stale 重搬、
  download 失败阶段化且不中断、坏 key 单次记账;verify 缺失/多余/抽样 hash 
  不一致/桶圈定;抽样确定性/数量/边界;桶序、listBuckets 失败传播、默认映射。
- `apps/api/src/storage-migration/supabase-source.test.ts`(新,9):fetch 桩
  (路由按调用次序出队——同 URL 两页不同应答,否则目录递归死循环);桶清单
  鉴权头与非 200、深度优先 + 全/相对路径归一化、offset 分页到短页、null 
  metadata、zod 拒坏形状、下载逐段编码与非 200。
- 文档:`docs/storage.md`(切片地图第二行勾掉 + 新「迁移」节:key 映射裁决、
  三档模式、校验协议、刻意不做清单)。

## 判断层(本次会话的关键判断与坑)

1. **选题层的真相核账**:#30 评论说「① #22 落地后接真实会话鉴权」,但
   index.ts:156 早已注入 `createSessionTokenVerifier(db)`——切片评论会过时,
   选题前要对照代码,不能只读 issue。同理 #22 的「剩余」全是运维/真实凭据,
   #27 全 gated。进行中 issue 里唯一能当场动工的就是本切片;这决定了今天
   不开新 issue、续 #31。
2. **StorageReader 不并进 Storage**:业务路由不需要枚举面(list 会进日志的
   裁决同样适用于「能枚举全桶的接口」);给 Storage 加可选方法会逼全仓几十处
   内联假实现陪跑,#324 已陪过一次(head)。独立接口 = 应用侧零波及,ops 面
   自带闸(validateStoragePrefix 禁空串——防误列全桶)。
3. **目标 = 应用侧同一份 S3 客户端**:迁移写的对象必须被运行中的应用读到,
   用同一客户端(同一 endpoint/凭证/桶)写桶,「迁移完成」才是可执行的事实,
   不是脚本自说自话。
4. **key 映射 `<桶名>/<原路径>` 是唯一要传下去的约定**:老系统桶间同路径互不
   相干,单桶化后桶名做首段才不撞;issue 说「数据库里保存的路径保持不变」,
   本脚本做到「路径一字不动 + 桶名前缀」,各域接下载 API 时按同一规则解析,
   不设第二张映射表。
5. **断点续跑不建 manifest**:目标 head 同 key 大小一致即跳过——重跑只补差异,
   没有状态文件要维护,坏掉的状态面比慢一次 head 贵得多。代价:源侧清单
   每次全量重枚举(Storage REST 分页,窗口量级可接受)。
6. **校验的「确定性」是设计出来的**:mulberry32 种子流 + 升序清单 + splice
   抽取,同种子同样本——重跑 verify 校验同一批对象,报告可对照。抽样跳过
   本桶已报错对象:失败已记账,再抽一次只会让错误数翻倍(首版就踩过:坏 
   key 在 copy 与 verify 各记一次,测试当场抓出来——keyByPath 映射一次共用
   后修死)。extra(目标有源无)只报告不拦 ok:验收第 1 条是「源的都在」,
   目标孤儿要有名字但不是本次失败。
7. **Supabase Storage list 的 `name` 形态两可**(相对前缀 vs 全路径,随服务
   版本):`relativeTo` 归一化两种都吃,目录下钻用「剥前缀后的相对名 + 拼接」,
   不赌部署版本。下载路径逐段 encodeURIComponent,空格/中文/`&` 安全。
8. **源凭证不进服务 env 主面**:SUPABASE_URL/SERVICE_ROLE_KEY 用
   pick().extend() 留在 CLI 内——服务 envSchema 多两个永不用的必填是污染;
   .env.example 也不放占位(放一个 service role key 的空位等于邀请抄进生产)。
   用法写在脚本头注释 + docs/storage.md 迁移节。
9. **刻意不做三件并写进文档**:无自动重试(可安全重跑使重试多余)、不并发
   (窗口量级是图片/PDF/单据,顺序搬完好过并发把源限流)、整对象进内存
   (GB 级备份桶用 --bucket 圈出去单独处理)。诚实边界写下来,好过让下一个
   会话猜。
10. **本仓 eslint 家规的三次返工**(全在测试桩):禁 `!`(改 `?.` + 显式
    断言)、require-await(假实现用箭头回 Promise.resolve,异步可迭代用手写
    `[Symbol.asyncIterator]` 助手 asyncIterableOf,不用 async 生成器语法)、
    zod v4 的 `.passthrough()` 已 deprecated(用 `z.looseObject`)。另:fetch
    桩必须按调用次序出队(同 URL 两页不同应答),否则目录递归在同一页上
    无限循环;深度优先枚举顺序与直觉的广度序不同,期望值按实现写。

## 验证

`DATABASE_URL=… corepack pnpm verify` 全绿:lint 0 错、typecheck 0 错、
测试 **147 文件 / 1539 测试**(本地 PG 真库,零 skip;新增 3 文件 39 测:
migrate.test 19 + supabase-source.test 9 + index.test 增 11)。

## 遗留

- **执行**:脚本就绪,切换窗口跑(dry-run → --apply → --verify;需
  SUPABASE_URL/SERVICE_ROLE_KEY + S3_*);顺序与验收口径见 docs/storage.md。
- #31 其余切片不变:12 处调用点随各域(#236/#229/#169/#147)、替换保历史
  版本随首个需要替换的消费域、FeedbackDialog 附件 UI 随反馈管理切片。
