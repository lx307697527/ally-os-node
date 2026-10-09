# 电子签名(#219:21 CFR Part 11 底座)

> #232 §13「合规设计」:受监管记录(批记录、检验、偏差、放行等)的电子签名要能
> 证明是本人、签的是什么含义、签后记录不可再改,并与审计追踪绑定。各业务模块
> 共用的底座能力——提供统一的签名组件与服务端接口,供各模块和审批(#221)复用。

## 已落地:签名内核(#219 切片 1,API only,PR #267)

- **数据模型**:`esign_signatures`(migration 内)——多态 subject
  (`subjectType` + `subjectId`)、`meaning` 枚举(performed / reviewed /
  approved)、版本绑定 `recordVersion` + `recordHash`(签名时刻的记录版本标与
  内容快照哈希)、`signedAt` / `receivedAt` 分列(离线原时间保留)、
  `clientToken` 幂等键;一人一号唯一索引;**append-only 触发器**——签后记录
  即锁定,更正走新记录或变更流程(与 audit_events 同一裁决)。
- **签名仪式 `POST /api/esignatures`**:会话之外重输密码(密码错 401)、签名
  用户必须已启用 2FA(#24 的强制门之外,仪式处再收一道,403
  `two_factor_required`);被签 subject 过两扇门——可见性门
  (`subjects/registry.ts`,看得到才签得到)与可签名注册表(`esign/registry.ts`,
  未注册 400)。重放按 `clientToken` 幂等返回同一行;离线补同步走同一端点,带
  原 `signedAt`(只拒明显在未来,容 5 分钟设备时钟偏移)。
- **签名墙 `GET /api/esignatures?subjectType=&subjectId=`**:一 subject 一墙,
  签名时间正序;行 = 签名人姓名、时间(原签名时刻)、含义、`recordVersion` /
  `recordHash`。可见者可读(同一扇可见性门)。
- **可签名 subject 是注册表**:`esign/registry.ts` 刻意随内核为空——「什么记录
  可以被签、签时处于哪个版本」只有属主域自己知道。属主域切片在模块装载时
  `registerSignableSubject(subjectType, { load })`,`load` 回答该记录签名时刻
  的 `recordVersion` 与内容快照。
- **审计**:`esignature.created` 事件(#29 词表),关联被签记录与版本(audit.md)。

## 已落地:web 两件套(#219 前端半边,仪式随 #279、展示墙随本切片)

- **`SignatureDialog`(仪式,apps/web/src/shared/components/SignatureDialog.tsx)**:
  presentational + 本地密码态——重输密码、含义按配置**展示**不由签署人挑
  (Part 11.50 展示;含义选择形态留给真正让签署人挑的消费域扩展该组件)、
  每次尝试新铸 `clientToken`(重放幂等兜「响应丢了」)。签名调用与错误路由归
  消费页(组件只管仪式)。首个消费场景:#221 审批待办页的签名级同意动作。
- **`SignatureWall`(展示墙,apps/web/src/shared/components/SignatureWall.tsx,
  本切片)**:一组件一 subject 墙——给定 refs 读真实 `/api/esignatures`,行 =
  姓名、含义、原签名时间、`record {recordVersion}`。裁决口径:
  - **组件永不点名 subject 类型**:refs 由承载页带来(approval 页传
    `approval_action`),#204 批次放行等后续承载页挂同一组件,不分叉。
  - **一 ref 读不了,整墙不可读**:部分可读的监管展示会悄悄藏签名——任一
    ref notfound/unavailable,整节显式「could not be loaded」,绝不半墙。
  - **离线签名在墙上自解释**:`receivedAt` 晚于 `signedAt` 超过 60s 的行带
    「signed offline, synced …」注记,原签名时间仍是墙上的时间——两个时间戳
    的差被说出口,不被静默抹平。
  - 四态全说出口:loading / unavailable / 空(No signatures recorded)/ 行。
    承载页只在确有签名可展时挂载(审批页只在 detail 的 actions 里有签过名的
    裁决时渲染),不常驻空节。

## 第一个承载页:审批待办页(#221 × #219,本切片)

`/approvals` 的请求详情面板:裁决史下方挂 `SignatureWall`,refs =
该请求所有带签名的裁决行(`approval_action`)。签名墙的服务端门(请求参与者:
发起人 + 各级点名人 + 已裁决人 + 配置角色现任持有者)与本详情页已有的门是同一
扇——能展开详情的人本来就过了墙的门,不会出现「看得到详情、读不了墙」的
半开门。会签/票签级按人逐一落签名(#284),墙上逐行可见,绑各自的裁决行版本。

## 属主域接入清单(下一个消费域照此做)

1. `registerSignableSubject(subjectType, { load })`——回答签名时刻的
   `recordVersion` 与快照;
2. `SUBJECT_LOADERS[subjectType]`——回答谁能看(可见性门,与业务可见性各说
   各的话);
3. 承载页在展示记录详情处挂 `<SignatureWall refs={…} />`;
4. 需要签名动作的业务动词自带仪式输入(参考 approval act 的
   `signature: { password, clientToken }` 与事务内 savepoint 回滚语义)。
