---
session_id: hand-written-219-signature-wall
branch: feat/219-signature-wall
date: 2026-10-09
reason: issue-219
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/219-signature-wall — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#219(电子签名与 Part 11 基础,phase-1)——评论剩余清单里的
  「签名墙的页面展示(随第一个有签署历史的承载页)」:#267 落了内核与签名墙
  API,#279 落了仪式对话框与第一个真实签署场景(审批签名级同意),承载页已在线上,
  本切片补读半边。PR 正文写 **Part of #219**(剩余的「含义选择」形态按既定裁决
  留给真正让签署人挑含义的消费域,保持 open)。
- **前置收尾(第 0 步)**:无 open PR(#320 已于同日合并,main CI/Deploy 绿)、
  无残留 worktree、主检出干净——直接进选题。
- **选题**:phase-1 剩余逐个核对——#221 金额域首接线压在 #229/#231(phase-2
  属主域)、#226 压在 #206/真实「先审后上」需求、#220 压在属主域/通用面板/#206、
  #233 压在 #220/#206/#223;#222 的剩余里有一个自包含修复切片(PUT custom-fields
  可选字段显式 null 清值 500,#224 评论建议),但 #219 编号在前且有已解锁切片,
  按 ①+② 规则选 #219。
- **claim**:`claim_issue.py claim --issue 219` 成功(接替上一会话的租约)。
- **数据库**:零 schema、零 API、零 migration 改动(签名墙 API 是 #267 存量);
  verify 带 DATABASE_URL 跑全量(结果见文末)。

### 本切片改动的文件

- `apps/web/src/shared/lib/esign-client.ts`(新):`createEsignAdapters` —
  `wall(ref)` 读 `GET /api/esignatures?subjectType=&subjectId=`(参数
  encodeURIComponent),zod 收口 `signatureRowSchema`(Part 11.50 字段 +
  recordVersion/recordHash + signedAt/receivedAt 分列 + signer);404 →
  `notfound`(可见性门,与审批详情 notfound 同语义),其余 → `unavailable`。
  纯函数居此文件(jsdom-free 仓库纪律:组件只做接线,纯层可离 DOM 单测):
  `isLateSync`(receivedAt−signedAt > 60s)+ `LATE_SYNC_MS`。
- `apps/web/src/shared/components/SignatureWall.tsx`(新):一组件一 subject 墙,
  refs 由承载页带来——组件内不出现任何 subject 类型字面量;react-query 一次
  Promise.all 取全部 refs,**任一 ref notfound/unavailable 整墙显式不可读**
  (部分可读的监管展示会悄悄藏签名);四态全说出口(loading / unavailable /
  空 / 行);离线签名行带「signed offline, synced …」注记,原签名时间仍是墙上
  时间;adapters 可注入(依赖注入规则)。
- `apps/web/src/shared/pages/Approvals.tsx`:请求详情面板裁决史下方挂
  `<SignatureWall refs={带签名裁决行 → approval_action refs}>`;只在
  `view.actions.some(a => a.signature !== null)` 时挂载,不常驻空节;页头
  注释同步(墙的门 = 请求参与者,与本详情页已有的门是同一扇)。
- 测试:`signature-wall.test.ts`(新,11 条)——client 端点/参数编码/404 分流/
  zod 行契约(parse 真测:缺 recordVersion 拒),组件四态 testids、
  Part 11.50 行、一 ref 挂全墙、组件不含 subject 字面量、isLateSync 真值
  (晚同步 / 即时同步 / 恰在阈值不标),页面接线(refs 形状、条件挂载)。
- `docs/esignatures.md`(新):#219 能力文档首次成文——内核(#267)裁决、
  web 两件套(SignatureDialog 仪式 / SignatureWall 展示)、第一个承载页、
  属主域接入清单(下一个消费域照此做)。

### 验证

- `DATABASE_URL=… corepack pnpm verify` 全绿 **133 文件 / 1401 测试** 零 skip
  (+1 文件 +11)。本地 postgres 真库集成。
- **环境抖动一次**:首轮全量 `rules.test.ts` afterAll `pool.end()` 30s 超时
  (该文件 20 条测试全过,纯清理挂起);单独复跑 3s 绿,第二次全量全绿——
  本地 postgres 全量并发下的清理抖动,与本切片零 API 改动无关;CI 用自己的
  postgres 服务容器,不受影响。
- lint 两处 `prefer-optional-chain`(`a !== undefined && a.b` → `a?.b` /
  `rows?.length === 0`),分支链终态 null 保持「无数据不说谎」。

## 判断层(手写)

1. **切片选择的核对成本**:phase-1 的「剩余」大多是外部门(#221→#229/#231、
   #226→#206、#220→属主域、#233→#220/#206/#223),真正可做的要逐条评论核对
   而不是只看 issue 标题。#219 的签名墙是唯一「前置已合并、自身可独立验收」
   的——它的前置(#279 第一个签署场景)两天前才落地,这正是「评论里有未完成
   切片优先续做」规则的用法:#267 当时刻意留的口子,现在能合上了。
2. **墙的粒度**:签名绑在裁决行(`approval_action`,一行 ≤1 签),「一个请求的
   墙」不是 API 的粒度。裁决:组件一 subject 一墙、页面侧组合(refs = 全部
   带签名裁决行)——不在 API 上造「请求级墙」的特例,审批域的注册
   (`SUBJECT_LOADERS.approval_action`)与 wall 端点零改动。将来 #204 批次
   放行的「一墙多签名」(performed/reviewed/approved 各一行)才是这个 API
   形状的主场,审批页只是它的第一个消费者。
3. **部分可读 = 藏签名**:一 ref 读不了就整墙报「could not be loaded」,不渲染
   拿到的部分。监管展示要么完整要么明说不可读——half-wall 在合规语境下是
   伪造。notfound(可见性门拦住)与 unavailable(网络/解析)分开说,前者与
   审批详情的 notfound 同一扇门,不会出现「看得到详情、读不了墙」的观感矛盾
   (两扇门在服务端就是同一个参与者集合)。
4. **离线签名自解释**:墙上行 = 原 `signedAt`(事实),`receivedAt` 落后超 60s
   才加「signed offline, synced」注记。60s 阈值刻意大于服务端 5 分钟设备时钟
   容差的语义面——容差内的时钟漂移不该被当成「离线」;两个时间戳的差要说出口,
   不静默抹平。
5. **坑:enabled:false 的永久 Loading**。最初给空 refs 加了 `enabled:
   refs.length > 0`,反应过来这会让组件在 pending 永远显示「Loading
   signatures…」——一个说谎的空态。改为空 refs 自然走完 queryFn
   (Promise.all([]) = [])落到空态;页面侧则只在该有签名时挂载,不常驻空节。
   组件的防御态与页面的克制挂载是两层,各自成立。
6. **坑:jsdom-free 仓库里纯函数放哪**。isLateSync 起初写在组件 tsx 里、测试
   直接 import tsx——本仓库纪律是纯层住 .ts client(decision-table-editor
   同款),组件测试只读源码。挪进 esign-client.ts 后测试是真单测(parse、真值
   矩阵),不是字符串断言。
7. **全量 verify 的首绿陷阱**:本地全量并发下 afterAll 偶发超时(rules.test.ts
   pool.end),单文件与第二次全量都绿。教训与 #220 的 CI 基建抖动同款:先分清
   「测试挂」还是「清理挂」,本例 1401 条全过、挂的是 teardown,复跑即绿;
   不为环境抖动改代码。
