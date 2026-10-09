# 文件内核:预签名直传 + 权限签发(#31)

对象存储的记账内核。老系统 12 处 `storage.from(...)` 直调分散在各域(feedback、
support、portal 单据、签署 PDF……),桶策略各自为政;新系统从第一行起就是
`@ally/storage`(S3 协议:AWS S3 / MinIO / OSS / COS 同一份代码,换云只改
endpoint 与凭证)+ 本内核的控制面。设计依据:#31 + #147 合并范围;切片 1 落
内核与首个消费域(feedback 附件)。

## 切片地图

| 切片 | 内容 | 状态 |
| --- | --- | --- |
| 文件内核(切片 1) | `files` 表 + presign/complete/list/url/delete 五端点 + subject 注册表 + pending 清扫 + feedback_report 注册 | ✅ 本切片 |
| Supabase → S3 对象迁移 | 按原路径批量复制 + 抽样校验数量与 hash(验收第 1 条) | 待做(需双方凭证,随切换窗口执行) |
| 老调用点替换 | 老系统 12 处 `storage.from(...)` 对应的域(签署 PDF #236、单据 #229、标签图 #169、ops 文件 #147……) | 随各域迁移 |
| 历史版本 | 替换文件保留历史版本(#147 ops 文件范围) | 待做(随首个需要"替换"的消费域) |

## 形状

- **`files` 表 = 对象世界的账本**:一行一个文件,多态挂在 subject
  (subjectType/subjectId,与 comments/follows/esign 同一形态)上。合法 subject
  类型、准入参数(类型白名单、单文件与总数上限、下载 TTL)与「谁能传/谁看得到」
  由 `apps/api/src/files/registry.ts` 逐域注册——`feedback_report` 是第一个
  (≤3 张图、单张 ≤5MiB、下载 600 秒,数值承老 feedback-actions),后续域
  (#236 签署 PDF、#169 标签图、#128 单据存档……)各自带参数进场,内核不预置
  任何业务的数值。
- **五端点,字节不经 API**:
  1. `POST /api/files/presign` — 门后校验准入,落 **pending** 行,发预签名
     PUT(300 秒)与对象 key;
  2. 客户端直传字节到桶(不经 API,不受请求体大小限制);
  3. `POST /api/files/:id/complete` — HEAD 确认对象真的在,转 **ready**,用
     实测字节数覆写声明值,落 `file.added` 审计;
  4. `GET /api/files?subjectType=&subjectId=` — 只回答 ready;
  5. `GET /api/files/:id/url` — 按需铸短时效签名 GET;`DELETE /api/files/:id`
     — 上传人删行,对象提交后尽力删。
- **key 无用户输入**:`<keyPrefix>/<subjectId>/<uuid>`——uuid 既是唯一性也是
  防遍历;原文件名只活在 `file_name` 列服务下载命名,进不了 key(与
  comment_attachments 同一裁决,BUG-325 类孤儿在此形态下没有生成的土壤)。

## 裁决

1. **记账与落桶的顺序反转,是直传的结构结果不是偏好**:评论附件「先落桶后
   记账」防 BUG-325(落桶成功、记账丢失 → 永久孤儿);直传做不到先替客户端
   落桶,顺序必须反转——presign 先落 pending 行再发预签名,complete 用 HEAD
   把「客户端说传了」核实成「对象真的在」。反转的代价是引入 pending 死态
   (拿了预签名永远没传),由 `file-uploads-cleanup`(worker,每 10 分钟)兜底:
   行按年龄删(24 小时)、对象尽力删且**先行于行删**(行删了 key 就无从查起;
   对象删失败时行留待下一轮,台账始终指向还没删掉的东西)。
2. **大小两级裁决,不谎称应用层拦得住一切字节**:presign 按声明值准入(注定
   超限的请求在动字节前拿到答案),complete 用 HEAD 实测覆写(台账记 S3 里
   真实存在的大小)。S3 预签名 PUT 不绑 Content-Length,字节级硬上限是桶策略
   /生命周期的事;实测超限 → 拒绝 complete,行留 pending 由清扫回收。
3. **签名 URL 只发给有权限的用户,且不进列表**:列表会进日志,长时效 URL
   不能跟着日志到处跑(评论附件同一裁决);`/url` 端点是唯一发口,TTL 由
   注册表逐域定(feedback 600 秒,承老「long enough to look, short enough to
   leak badly」)。
4. **complete 与删除验 uploadedBy**:老 submit_feedback_report 落库前重验 key
   归属的同一裁决——谁能动这个 key,账上的行说了算,不只是 subject 说了算。
   重试丢掉的 complete 幂等(行已 ready 且是本人,原样回答)。
5. **pending 不审计**:presign 不写审计(pending 不是发生过的事实,可能永远
   不发生);complete 落 `file.added`、删除落 `file.deleted`(detail 带
   subjectType/subjectId,活动流机制自动收录——属主域在 subjects/registry.ts
   注册后即出现在对象时间线里)。
6. **uploadedBy 不带 CASCADE**:文件是证据不是社交内容(与 esign_signatures
   同裁、与 comment_attachments 的 CASCADE 刻意相反)——挂着自己的账号删不掉,
   正常下线路径是停用。
7. **storageKey 唯一索引 = 注册表**:一个 key 只许一行引用;S3 的 DeleteObject
   对不存在的对象同样答成功,清扫与删除路径都幂等。

## 新域接入清单

新的文件消费域(签署 PDF、单据存档、标签图……):

1. 在 `apps/api/src/files/registry.ts` 注册 subject:`keyPrefix`(命名空间)、
   `maxFileBytes` / `maxFilesPerSubject`(准入数值,写出处)、
   `admittedContentTypes`(封闭白名单)、`urlTtlSeconds`、`loadSubject` /
   `canView` / `canAttach` / `lockSubject`(锁行供名额在事务内裁决);
2. 前端/调用方按 presign → PUT → complete 三步走,列表与 `/url` 端点做展示;
3. 集成测试至少:一条快乐路径(presign → 直传 → complete,断言实测覆写声明)、
   一条门序(未注册 400 / 不可见 404 / 动词 403)、一条准入拒绝。

## 与评论附件(comment_attachments)的关系

并存,不合并。评论附件是评论域的行(随评论共生灭、服务端 put、每评论 5 个
10MiB 上限),文件内核是通用记账面。已有一个消费域时没有合并的读者;若将来
评论附件要改直传,它以 `comment` 注册进本内核,列是那天的迁移题,不是现在
的预设计。

## 读回能力(#128 起,可选)

`Storage` 接口的 `get` 是**可选能力**:上传内核的最小面不被读路径绑架,既有实现
与测试假实现不用跟着长方法。服务端生成的正式单据(发票 PDF 存档)由系统自己
读回分发(内联字节、后续邮件附件),与「浏览器直传、下载走预签名 URL」的附件
流是两条路。需要读回的调用方统一走 `readStoredBytes` 收窄:实现缺能力 = 部署
配置错误,typed error 让路由层映射 500(fail closed),不是悄悄降级。对象不在
返回 null,其他失败原样抛(与 head 同一裁法)。
