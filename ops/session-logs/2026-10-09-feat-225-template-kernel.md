---
session_id: hand-written-225-template-kernel
branch: feat/225-template-kernel
date: 2026-10-09
reason: issue-225
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/225-template-kernel — 2026-10-09

> 机械层本次由 agent 手写(ZCode 定时迁移会话);判断层为本次会话手写。

## 机械层(自动)

- **引用的 issue**:#225(配置工作室:报表与模板,phase-1)——切片 1(编号
  规则内核,#273)与编号配置 UI(PR #286)已合并。本切片落 issue 剩余项 2 的
  **模板管理内核**:统一内容模板存储(邮件为首个 channel)+ `{{var}}` 渲染
  语义 + 不可变版本史/回滚 + 预览。PR 写 **Part of #225**(issue 保持 open)。
- **前置收尾(第 0 步)**:fetch --prune(#328 的远端分支已删);无 open PR;
  无残留 worktree;主检出干净(无并发会话 WIP)。
- **选题**:按记忆 next(#225 模板管理切片 或 #34 app 层)核对 #225 评论剩余
  项:Superset 属部署面(gated)、编号 UI 已合并、真实消费方随 #229/#231、
  version 列随 #226——唯一可当场动工且被 issue 评论明确排为「切片 2」的就是
  模板管理。#34 验收是 Slack 告警(纯 infra),对比后选 #225。claim #225
  (陈旧租约自动接管)。
- **参考(老系统,只读)**:`comms.email_templates` + `comms.email_template_versions`
  (DB 表 + `{{var}}` 占位符,渲染在调用方;`_shared/email_shells.ts` 的
  renderPlaceholders:**缺失变量保留 `{{name}}` 原样**——可诊断的显性失败);
  短信**没有**模板层(正文调用方直传);PDF 是代码渲染器 + 常量(新系统已由
  #128 的 @ally/pdf 承担);老系统同样没有模板管理 UI(p3c 未建)。
- **落了什么**:
  - `packages/templates`(新包):renderTemplate / extractTemplateVariables /
    missingTemplateVariables(老系统 renderPlaceholders 同语义),channel
    **注册表**(email 平台自注册,subjectRequired;短信随其基建注册即用,
    零 schema 变更),zod 形状 + templateContentError(channel 感知的内容
    校验,POST/PATCH/preview 三面共用一个权威)。
  - DB:`system_templates`((channel, template_type) 唯一,is_active 开关,
    version 列)+ `system_template_versions`(不可变版本史,回滚 = 旧内容落成
    新版本)。migration 0044(expand-only)。
  - 权限点 `templates.configure`(owner/admin,configure 族),permissions.ts
    与 docs/permissions.md 双写明分立理由。
  - 路由:`GET/POST /api/templates`、`GET/PATCH /api/templates/:id`、
    `POST /api/templates/:id/rollback`、`POST /api/templates/preview`,全部
    templates.configure 门,注册表六条声明,审计 `template.created / updated /
    rolled_back`(逐字段 from/to)。
  - 消费方接线:`apps/api/src/templates/service.ts` 的 `resolveAuthEmail` ——
    三封认证邮件(验证/重置/邀请,#22/#26 的内置文案降为兜底)先查启用模板,
    行不在/停用/查行失败一律回退内置(resolveAuthEmail 自 catch 不抛)。
- **测试**:packages/templates 14 测(渲染语义逐条钉死:缺失保留、空白容忍、
  空串≠缺失);templates.test.ts 集成 12 测(独立临时库):CRUD+版本史+回滚
  +预览+审计、409/400(unknown_channel/subject_required)/403(alice 零角色)、
  resolveAuthEmail 四态契约、**邀请邮件端到端**(真 better-auth handler +
  spyMailer 与配置面共享同一临时库:模板行由配置面写、重置链路读,停用后
  同链路回内置文案)。
- **验证**:`DATABASE_URL=… corepack pnpm verify` 全绿(基线 +2 文件 +26 测)。
- **剩余项(Part of #225,issue 保持 open)**:
  1. 模板管理 web UI(配置工作室页面:channels+templates 列表、编辑、版本史、
     预览——数据面已就绪,随配置工作室前端切片);
  2. 短信 channel(随短信基建进场注册,零 schema 变更);
  3. 更多消费方:#131(邮件模板管理/批量发送/分析)直接吃本内核,mail merge
     渲染统一在服务端(#131 迁移要点)由此接缝承担;
  4. PDF 品牌配置的 logo 接缝(#128 剩余②,随 web 管理面);
  5. Superset 自助报表/仪表盘/定时发送(`infra/` 部署面,验收第 1、2 条随它)。

## 判断层(本次会话的关键判断与坑)

1. **「模板统一管理」统一的是语义,不是存储**:PDF 品牌配置(单行结构化
   配置)与内容模板(主题+正文)形状根本不同,老系统也是分开的(pdf 常量
   vs email 表)。强行合成一张表会让两边都别扭;真正的统一面是占位符契约、
   审计词表、channel 注册表、configure 权限族、未来同一个管理 UI。channel
   用开集 text + 注册表(numbering registry 同裁:注册 = 「我真的会按这个
   channel 消费」的承诺),短信进场 = 一行注册,不是一次 migration。
2. **权限点分立:templates.configure ≠ 沿用 invoices.manage**:#128 头注说
   模板管理 UI「沿用同一权限点」,但那条裁决的语境是 **PDF 品牌配置 UI**
   (收款指示是银行信息,财务的脸面)。邮件模板是全员通信的措辞面:admin
   是配置工作室管理者(#232 §12)却**不持有** invoices.manage——沿用会让
   配置工作室的管理者改不了邮件模板。新点进注册表(owner/admin 同族),
   permissions.ts 与 docs/permissions.md 双写分立理由;PDF 品牌配置的门不动。
3. **不进 config-revisions(#226),但比 PDF 配置多走一步**:同族裁决(即改
   即生效、无先审后上需求)延伸到内容模板;不同的是模板有明确的回滚消费方
   (#131 验收「版本回滚」),所以自建不可变版本表(老系统
   email_template_versions 同形)而不是只靠审计。回滚 = 旧内容落成**新**
   版本(config_revisions 的 rolled_back 同一语义):历史不改写,回滚本身
   可追溯、可再回滚。
4. **没有 DELETE 端点是刻意的**:停用(is_active=false)= 消费方回退内置文案
   ——「回到内置」才是模板删除的真实语义,且可逆、版本史留档。测试把这
   三态(启用接管/停用回退/删行回退)钉死。
5. **消费方 fail-open 到内置是设计不是疏忽**:认证邮件「发送失败绝不阻塞」
   (老系统 auth-send-email 裁定)往前挪一步——查模板失败(DB 抖动)也回退
   内置并记 warn,resolveAuthEmail 自 catch 不抛,不依赖调用方记着兜。模板
   面的任何故障都不允许变成认证面的故障;可用性优先于定制。
6. **BUG-285 的工序在模板路径必须重申**:主题是邮件头用未转义变量、正文
   (HTML)里用户可输入的 name/email 转义、link 永不转义(转义弄死
   querystring 的 `&`)——模板只换措辞不换工序,resolveAuthEmail 里三者的
   分工与内置渲染逐字对应,集成测试用 `Grace <b>Hopper</b>` 钉住。
7. **端到端测试跨两个 app 实例共享同一临时库**:配置面用 x-test-user 假
   会话,邀请链路要真 better-auth handler——同一个 db 上起两个 createApp,
   模板行由配置面写、重置链路读,「接线正确」才是被证明的事实而不是
   resolveAuthEmail 的单元自证。坑:审计 detail 过了 jsonb 会**重排键序**,
   changes 断言要比集合(sorted toEqual)不比顺序——首跑就栽在这。
8. **坑:shell cwd 不随后台命令的 cd 走**:worktree 创建后的第一次
   pnpm install 与 vitest 都跑在了主检出(RUN 行显示 D:/Code/ally-os-node
   才发现)。无害(同 commit 同内容)但浪费时间;此后每条命令显式
   `cd <worktree>`。另一个小坑:新包进 workspace 后必须重跑 pnpm install
   (workspace:* 链接)+ 在 apps/api package.json 的 dependencies 里显式加
   @ally/templates,TS 才解析得到。
