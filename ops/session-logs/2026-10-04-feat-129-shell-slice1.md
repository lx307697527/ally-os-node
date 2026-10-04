---
session_id: hand-written-129-shell-slice1
branch: feat/issue-129-shell-slice1
date: 2026-10-04
reason: issue-129-slice-1
prompts: 1
unparseable_transcript_lines: 0
models: (zcode)
tokens_in: 0
tokens_out: 0
cache_creation_tokens: 0
cache_read_tokens: 0
thinking_blocks: 0
---

# Session log — feat/issue-129-shell-slice1 — 2026-10-04

> 机械层本次由 agent 手写(ZCode worktree 会话,SessionEnd hook 未触发);
> 判断层为本次会话手写。

## 机械层(自动)

- **时间跨度**:2026-10-04 晚间
- **引用的 issue**:#129(后台框架与通用交互)切片 1:登录页 + 后台壳
- **PR**:feat/issue-129-shell-slice1

### 改动的文件

- `packages/ui/`(新增 `@ally/ui`):自 ally-os `packages/ui` 移植 ——
  `tokens.css` + `theme.css`(跨应用 token 层,原样移植)、`lib/cn.ts`
  (clsx,明确不用 tailwind-merge)、`Button` / `Card` / `Input` / `Menu`
  (Base UI 原语上的统一下拉配方)/ `Typography`;`index.ts` 只导出壳需要的
  子集,其余组件随用随迁;`token-bridge.test.ts` 保留两半文本检查
  (theme 引用的名字必须在 tokens 里定义;token 别名图自洽)
- `apps/web/`:Tailwind v4(`@tailwindcss/vite`)接入,`src/index.css` 为唯一
  样式入口(`@source "../../../packages/ui/src"` 三层 —— 两层会让 ui 包的
  工具类整体缺席,这是本次踩过的坑);自托管字体(woff2 + OFL/Apache
  license 文件)与 logo/favicon 公共资产照旧系统搬运
- `apps/web/src/shared/lib/`:`auth-client.ts`(better-auth react 客户端,
  同源 `/api/auth`,开发走 Vite 代理)、`session.ts`(useSession/signOut
  适配层)、`session-identity.ts`(会话徽章文案规则,展示逻辑原样移植,
  读取半边从 Supabase user_metadata 改为 better-auth 平铺 name/email)、
  `return-to.ts`(返回路径,拒绝协议相对地址)
- `apps/web/src/shared/components/`:`AuthFrame`、`ShellLoadingFrame`、
  `RequireAuth`(登录后跳回来源页)
- `apps/web/src/shared/pages/`:`Login`(提交走 `authClient.signIn.email`,
  服务端拒绝原文展示,页面自身无目的地)+ `auth/SignIn`(屏幕不决策;
  social 槽位与 forgot-password 链接随 #22 后续切片回来,避免死链)
- `apps/web/src/shared/shell/`:`ShellFrame`(壳框,原样)、`RailIcon`
  (描边规格 24 网格/17px/1.7,目前只带 overview 一个字形,随行随加)、
  `rail-groups.ts`(八区导航表 + 路由派生,纯数据无 React,可 node 单测)、
  `InternalShell.tsx`(navy 顶栏分区标签 + 分组 rail + 上下文条 + 会话
  菜单;钉选/通知铃/record chip 留给后续切片)
- `apps/web/src/pages/`:`Dashboard`(占位卡片 + API 健康探测)、`Region`
  (空区的 note 即页面内容,标签不死链)
- `apps/web/src/*.test.ts`:`rail-groups.test.ts`(导航表断言)、
  `internal-shell.test.ts`(壳 markup 文本纪律)、`login.test.ts`
  (登录页无硬编码目的地 + RequireAuth 携带来源)、
  `session-identity.test.ts`、`return-to.test.ts`

### 验证

- `corepack pnpm verify` 通过(lint → typecheck → test,94 passed /
  15 skipped DB-gated)
- `vite build` 通过;浏览器端到端冒烟(本地 PG + API 3100 + web 5174):
  错误密码显示服务端原文 `Invalid email or password` → 正确密码进入
  `/overview`(八区标签、分组 rail、会话徽章姓名+缩写、Dashboard 健康探测
  全部呈现)→ Sales 标签进 region 页(note 即内容)→ 会话菜单 Sign out
  回登录页

## 判断层(手写)

1. **切片范围**:#129 全题(会话超时/版本检查/删除撤销/通知铃/i18n/ops)
   远超一次 run;本切片只做「登录页 + 后台壳」—— 对应验收标准第一条
   (外观与导航一致)的地基,其余留给后续切片,issue 保持 open。
2. **移植以仓库为准**:issue 正文说的「Outfit 字体、indigo/violet」是老
   仓库的陈旧描述;ally-os 现行设计系统是 `@ally-os/ui` 的 tokens/theme
   (SF Pro 栈 + self-host 字体 + navy/amber),照搬,故新系统与老系统在本
   机渲染一致。
3. **导航表先空着七区**:业务模块未迁移,沿用 ally-os 的纪律 —— 空组打印
   note(说明哪个模块来填),不做死链;顶部标签指向 `/regions/:key`。
   权限显隐等 #23 RBAC 落地后再接。
4. **`@source` 相对路径坑**:从 `apps/web/src/index.css` 到仓库根是三层
   `../`,写两层时 Tailwind 扫不到 `packages/ui` 源码,Button/Card 的
   token 工具类整体缺席(typecheck 不报,只有渲染能发现)。
5. **kysely 对齐复查**:web 引入 better-auth 后,`drizzle-orm` 在 db/api
   仍解析到同一个 kysely-flavored 实例(0.29.6 单例),无分裂。
