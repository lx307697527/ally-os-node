---
session_id: hand-written-31-storage-files-kernel
branch: feat/31-storage-files-kernel
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

# Session log — feat/31-storage-files-kernel — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#31(文件存储迁移 Supabase Storage → S3,phase-1)——零
  评论未动工。本切片落**文件内核**(切片 1):`files` 账本 + 预签名直传五端点 +
  subject 注册表 + pending 清扫,首个消费域 feedback 附件。PR 写 **Part of #31**
  (对象迁移脚本绑切换窗口、12 处老调用点替换随各域迁移,见 docs/storage.md
  切片地图)。
- **前置收尾(第 0 步)**:无 open PR(#322 已于同日早些合并);发现
  `.claude/worktrees/28-error-tracking` 有 #28 的 WIP 且租约被持有(到
  11:37Z,worktree 一小时内有改动)——**别的会话正在进行中,不清理不动它**。
- **选题**:优先级 ① 逐个核对:#27 剩余三片全部有外部门槛(管理页等可见性
  需求、IP 黑名单等真实滥用场景、honeypot 等第一个公开表单域),租约已释放,
  释放后不占;#219 含义选择、#225 模板切片、#220–#226 剩余项的门槛裁决承
  #27 会话的当日核对。② phase-1 按编号:#28 在做(租约活跃);**#31 是下一个
  未动工者**;#33/#34 的验收压在 RDS PITR 演练与 CloudWatch→SNS→Slack(纯
  infra 门槛,应用层能做的部分:#33 的清理任务已随 #27 落地/归 #28,#34 的
  依赖检查等 Resend/Twilio/HubSpot 域进场)。③ 未到。claim #31 一次成功。
- **参考**:老系统 `apps/allyos/src/system/lib/feedback-actions.ts`(≤3 张图、
  私有桶、key 首段=上传者 id、落库前重验 key 归属、签名 URL 600s「long enough
  to look, short enough to leak badly」);老 RLS(admin/super_admin/ops)按
  docs/permissions.md 映射收敛;本仓库 comments.ts 的附件家法(门序、先落桶后
  记账、按需签名 URL)与 subjects/esign 注册表家法。

### 本切片改动的文件

- `packages/storage/src/index.ts`:+ `head(key)`(HEAD 实测字节数;对象不在回
  null,基础设施故障原样抛——「查不到」和「没上传」是两回事)+ `isNotFound`
  识别(SDK 把 404 包在 name / $metadata 里)。
- `packages/db/src/schema.ts`:+ `files`(多态 subject 挂载、pending/ready
  枚举、声明→实测字节数、storageKey 唯一索引当注册表、uploadedBy 不带
  CASCADE、pending 部分索引供清扫扫描)。Migration `0041`(expand-only)。
- `apps/api/src/files/registry.ts`(新):`FILE_SUBJECTS` 注册表(keyPrefix、
  maxFileBytes、maxFilesPerSubject、admittedContentTypes、urlTtlSeconds、
  loadSubject/canView/canAttach/lockSubject)+ `feedback_report` 注册(数值承
  老:3 张/5MiB/600s,白名单只收图片)+ `loadFileSubject` 统一门入口 +
  sanitizeFileName(与评论同一裁决)。
- `apps/api/src/routes/files.ts`(新):presign(门序→准入→预检→铸 URL→锁内
  记账 pending 行)、complete(HEAD 核实→实测覆写→ready+审计;幂等重试)、
  list(只答 ready)、url(按需铸短时效 GET)、delete(上传人动词,行删事务内、
  对象提交后尽力)。
- `apps/api/src/routes/registry.ts`:五条 /api/files 路由声明(session 门)。
- `apps/api/src/authz/permissions.ts`:+ `feedback.manage`(owner/admin 默认;
  老 RLS 三角色按映射表收敛,ops_assistant 不预授——裁决写进注释)。
- `apps/api/src/app.ts`:filesRoutes 挂载(feedback 之后)。
- `apps/worker/src/files/pending-cleanup.ts` + `files/index.ts`:
  `file-uploads-cleanup` 每 10 分钟,pending 行 24h 过期、对象先行尽力删
  (行删了 key 就无从查起)、删不掉的行留待下轮。
- `apps/worker/src/index.ts` + `package.json`:filesJobs 登记 + @ally/storage
  依赖(与 API 同一份 S3 客户端构造)。
- 既有套件的 36 处内联 Storage 假实现补 `head`(33 处 rejection 型脚本化、
  comments.test.ts 的 Map 型补真实现、auth/paypal/stripe 的多块套件手工补)。
- 测试:`apps/api/src/routes/files.test.ts`(11:401/门序矩阵/准入/锁内并发
  名额/实测覆写/幂等/object_missing/实测超限/staff 可读不可传/下载 TTL/删除
  审计)、`apps/api/src/files/registry.test.ts`(4:注册表契约数值钉死、白名单、
  文件名 sanity)、`apps/worker/src/files/pending-cleanup.test.ts`(2:年龄
  清扫+ready 保留、对象删不掉行保留)。共享库套件的审计断言按 target=fileId
  圈定(append-only 表不可清)。
- 固定断言同步:authz.test.ts 的 admin 默认集、app.test.ts 的 /api/me 权限
  清单、route-auth.test.ts 经 routes/registry.ts 自动覆盖。
- 文档:`docs/storage.md`(新:切片地图 + 形状 + 七条裁决 + 新域接入清单 +
  与评论附件的关系)、`docs/permissions.md`(+feedback.manage 段)、
  `docs/feedback.md`(附件面改指文件内核,web 面缺口移到管理切片)。

**验证**:`DATABASE_URL=… corepack pnpm verify` 全绿 138 文件 / 1437 测试
(+3 文件 +22,零 skip;本地 PG 真库)。本地库先 `db:migrate` 应用 0041。
session log:`ops/session-logs/2026-10-09-feat-31-storage-files-kernel.md`。

## 判断层(手写)

1. **#31 的「验收绑切换日」不是整片放弃的理由,是切刀的理由**。#27 会话把
   #31 判为「验收绑老系统 12 处调用点替换(切换日)」而跳过——验收第 1/3 条
   确实绑(历史文件迁移、调用点替换),但验收第 2 条(上传/下载/删除过 API
   权限检查)和 #147 合并范围的内核形状是本地面。把它切成「内核+首个消费域
   (本切片)/对象迁移脚本(切换窗口)/调用点替换(随各域)」三片,phase-1
   就少一块完全空转的洼地。判据:切片地图进 docs,剩余项有明确主,不是
   「以后再说」。
2. **顺序反转是直传的结构结果**:评论附件「先落桶后记账」防 BUG-325 的裁决
   不能照抄——直传做不到先替客户端落桶,presign 必须先落 pending 行。反转
   的代价(pending 死态)由清扫任务兜,而不是回避直传或假装审计 pending。
   老系统的教训能继承的是**意图**(不留无账字节),不是**顺序**(顺序由谁先
   谁后能做什么决定)。
3. **两级大小裁决,并把「拦不住的」说清楚**:S3 预签名 PUT 不绑
   Content-Length,应用层只做「声明值预检 + HEAD 实测覆写/拒收」,字节级硬
   上限是桶策略的事。把这行写进 docs 和代码注释——比假装应用层拦得住一切
   字节诚实,也比「所以不做准入」安全。
4. **feedback.manage 的默认集是映射题不是发明题**:老 RLS 三角色
   admin/super_admin/ops,映射表 super_admin→admin 现成,但「ops→谁」要裁决:
   ops_assistant 是运营执行角色,不该因角色名像就继承他人反馈的证据读面,
   并入 admin(操作者角色),ops_assistant 留给管理队列落地时按需扩。反向也
   成立:#31 的员工读门先做成权限点(而非提交人-only),是因为附件的全部
   意义在于有人复核——没有读门的证据是 bytes 写进黑洞。
5. **坑:drizzle 对「刚生成又改列名」要交互确认**。0041 用 owner 命名生成过
   一版,重命名为 subject 后 `db:generate` 报「Interactive prompts require a
   TTY」——drizzle 在对 0041 快照做 diff,要把改名列标记成 rename。迁移没
   离开过本机,删掉 0041 快照 + journal 条目、从 0040 重新生成,即无此问。
   教训:生成后先审再改名;改名要在快照链里从头来。
6. **坑:多块 createApp 的测试文件,脚本只补了第一处**。Storage 接口加
   head() 后 36 个套件的假实现要补——rejection 型统一脚本化一次过,但
   auth/paypal/stripe 三个文件各有两个 createApp 块,第一轮的
   `replace(…, 1)` 只补了第一个;第二轮全量替换又叠出重复行(相邻重复
   head 行),第三轮才清干净。TS1117(重复属性名)比 TS2741(缺属性)更该
   先看——出现它说明上一轮补重了。
7. **共享库套件与 append-only 审计表的相处**:审计断言不能 afterEach 清
   (0007 触发器拒 DELETE,TRUNCATE 又只属于临时库套件的特权),按
   `target = fileId`(uuid)圈定到本套件自己的行——随机主键在这里就是隔离
   单位,与 rate-limit 套件「标识随机、断言只看自建行」同一手法。
8. **多态词汇统一到 subject**:files 表最初用 ownerType/ownerId(#147 文案
   说「所属对象」),落表前对齐成 subjectType/subjectId——comments/follows/
   esign/workflow/customFields 全是 subject 词汇,审计 detail 与活动流读的
   也是 subjectType/subjectId;发明第二套同义词是给未来的自己埋翻译层。
   #147 的「所属」语义由 FileSubjectContext.subjectUserId 承载,不丢。
9. **选题时读到了租约墙的正确用法**:`git ls-remote origin 'refs/heads/claims/*'`
   能看到全部租约 ref,但 ref 永久留存不等于租约活跃(释放只是前移指针)——
   判断「别的会话在做」要看 claim_issue.py status 的到期时间与 worktree
   mtime,不能只看 ref 存在与否。本次据此没动 #28 的 worktree,也没被
   27 个历史 ref 迷惑去「清租约」。
