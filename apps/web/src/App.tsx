// The composition root: routes, and the one place that reads the session to
// feed the shell its identity. Slice 1 of issue #129 — sign-in plus the
// internal shell. The health probe the old bootstrap page read moved to the
// Dashboard, where a signed-in operator can actually see it.
import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useNavigate } from "react-router-dom";

import { Dashboard } from "./pages/Dashboard.tsx";
import { Region } from "./pages/Region.tsx";
import { FeedbackDialog } from "./shared/components/FeedbackDialog.tsx";
import { NotificationBell } from "./shared/components/NotificationBell.tsx";
import { AuditLog } from "./shared/pages/AuditLog.tsx";
import { ApprovalConfigs } from "./shared/pages/ApprovalConfigs.tsx";
import { Approvals } from "./shared/pages/Approvals.tsx";
import { Automations } from "./shared/pages/Automations.tsx";
import { CustomFields } from "./shared/pages/CustomFields.tsx";
import { DeletedRecords } from "./shared/pages/DeletedRecords.tsx";
import { InvoiceDetail } from "./shared/pages/InvoiceDetail.tsx";
import { Invoices } from "./shared/pages/Invoices.tsx";
import { NotificationSettings } from "./shared/pages/NotificationSettings.tsx";
import { NumberingRules } from "./shared/pages/NumberingRules.tsx";
import { RateLimits } from "./shared/pages/RateLimits.tsx";
import { RulesRegistry } from "./shared/pages/RulesRegistry.tsx";
import { TaskDetail } from "./shared/pages/TaskDetail.tsx";
import { Tasks } from "./shared/pages/Tasks.tsx";
import { TeamUsers } from "./shared/pages/TeamUsers.tsx";
import { TwoFactorSettings } from "./shared/pages/TwoFactorSettings.tsx";
import { WorkflowTemplates } from "./shared/pages/WorkflowTemplates.tsx";
import { ForgotPassword } from "./shared/pages/ForgotPassword.tsx";
import { Login } from "./shared/pages/Login.tsx";
import { ResetPassword } from "./shared/pages/ResetPassword.tsx";
import { VerifyEmail } from "./shared/pages/VerifyEmail.tsx";
import { NewVersionBanner } from "./shared/components/NewVersionBanner.tsx";
import { RequireAuth } from "./shared/components/RequireAuth.tsx";
import { SessionTimeoutWarning } from "./shared/components/SessionTimeoutWarning.tsx";
import { InternalShell } from "./shared/shell/InternalShell.tsx";
import { sessionIdentityFromUser } from "./shared/lib/session-identity.ts";
import { createNotificationLiveChannel, type NotificationLiveChannel } from "./shared/lib/notification-live.ts";
import { createNotificationAdapters } from "./shared/lib/notifications-client.ts";
import { signOut, useSession } from "./shared/lib/session.ts";
import { useSessionTimeout } from "./shared/lib/use-session-timeout.ts";
import { useVersionCheck } from "./shared/lib/use-version-check.ts";

// Module scope, like the old live-notifications adapters: ONE adapters object,
// so the bell's refresh identity is stable for the poll hook.
const notificationAdapters = createNotificationAdapters();

function ShellHost(): ReactElement {
  const { user } = useSession();
  const navigate = useNavigate();
  // The idle-logout watch (#129 slice 2): the server's deadline, counted
  // down locally; the overlay renders OVER the shell, unmounting nothing —
  // taking the page away IS the data loss the warning exists to prevent.
  const { phase, secondsRemaining, stayLoggedIn } = useSessionTimeout();
  // The deployment watch (#129 slice 3): "is a newer build live than the one
  // this tab loaded?" — announced as a prompt, never acted on behind the
  // operator's back; the banner's Refresh click is the only reload.
  const newBuildId = useVersionCheck();
  // The bell + the feedback dialog (#129 slice 4): the shell gets a finished
  // bell element and a callback; the data and the dialog live HERE.
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const identity = sessionIdentityFromUser(user);
  // The bell's live channel (#110 slice 2), one per signed-in user id: the
  // socket nudges, the bell's own summary read stays the data truth. Rebuilt
  // only when the id changes (a different account signed in), closed on
  // unmount — a sign-out tears the socket down with the shell.
  const userId = user?.id;
  const notificationLive = useMemo<NotificationLiveChannel | null>(() => {
    if (userId === undefined) return null;
    return createNotificationLiveChannel({ userId });
  }, [userId]);
  useEffect(() => () => notificationLive?.close(), [notificationLive]);

  return (
    <>
      <InternalShell
        identity={identity ?? undefined}
        bell={<NotificationBell adapters={notificationAdapters} live={notificationLive ?? undefined} />}
        onSubmitFeedback={() => {
          setFeedbackOpen(true);
        }}
        onSignOut={() => {
          void (async () => {
            await signOut();
            navigate("/login", { replace: true });
          })();
        }}
      >
        <Outlet />
      </InternalShell>
      {feedbackOpen ? <FeedbackDialog onClose={() => { setFeedbackOpen(false); }} /> : null}
      {newBuildId !== null ? (
        <NewVersionBanner
          onRefresh={() => {
            window.location.reload();
          }}
        />
      ) : null}
      {phase === "warning" && secondsRemaining !== null ? (
        <SessionTimeoutWarning secondsRemaining={secondsRemaining} onStayLoggedIn={stayLoggedIn} />
      ) : null}
    </>
  );
}

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        {/* Where the confirmation mail's link lands (#22 email-verification
            slice) — public: the operator confirming a mailbox is by
            definition not signed in yet. */}
        <Route path="/verify-email" element={<VerifyEmail />} />
        {/* The password-reset pair (#22 password-reset slice) — public for
            the same reason: whoever asks for a reset link or spends one has
            forgotten the password that would have signed them in. */}
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          element={
            <RequireAuth>
              <ShellHost />
            </RequireAuth>
          }
        >
          <Route path="/" element={<Navigate to="/overview" replace />} />
          <Route path="/overview" element={<Dashboard />} />
          <Route path="/regions/:region" element={<Region />} />
          {/* 任务（#113 切片 1）：登录者的自己的待办；行属读写都在服务端。 */}
          <Route path="/tasks" element={<Tasks />} />
          {/* 任务详情（#110 切片 1）：本仓库第一个记录路由，也是任务通知的
              深链落点（?comment= 落到那条评论）；行属门在服务端，无关人
              得到明确的「不可用」，不猜测是删了还是无权。 */}
          <Route path="/tasks/:taskId" element={<TaskDetail />} />
          {/* 审批待办（#221 切片 3）：配置点名给我的在飞请求；裁决语境随
              待办行走，详情记录仍过单据可见性门——两扇门在页面里都说话。 */}
          <Route path="/approvals" element={<Approvals />} />
          {/* 发票（#192 切片 4：财务确认页）：invoices.manage 门后，待确认草稿
              是财务的主读法——系统出的每张票都从这里核对后发出（R-12-6），
              确认前不碰客户。 */}
          <Route path="/invoices" element={<Invoices />} />
          {/* 发票详情（#192 切片 4）：核对行、改草稿、确认发出、作废与收款台账
              都在这张票上；payment.* 两类收款告警的深链落点（billing.md 白名单
              裁决的承载页）。行属门在服务端，无关人得到明确的「不可用」。 */}
          <Route path="/invoices/:invoiceId" element={<InvoiceDetail />} />
          {/* 团队（#26）：用户生命周期管理面；服务端 users.manage 门——花名册、
              创建邀请（初始角色不带特权角色，R-16-6 门是特权角色的唯一入口）、
              改名、停用/启用（停用即全端登出，删除没有端点）。角色授予/撤销
              复用 #23 端点，202 审批流与 403 owner_required 原样上屏。 */}
          <Route path="/system/team" element={<TeamUsers />} />
          {/* 审计日志（#29）：System 区第一个页面；服务端 audit.read 门，
              无权限的账号在页面里得到明确的答复，不预设谁能进来。 */}
          <Route path="/system/audit" element={<AuditLog />} />
          {/* 限流拒绝台账（#27 切片 2）：被拦请求的管理可见面——验收第 3 条
              「管理页面能查看被拦截的请求」；服务端 audit.read 同门（与审计
              日志同一批读者）。台账是遥测不是闸门——429 的权威在计数器，
              页面只回答「谁在撞、撞什么、撞多狠」，没有任何放行动词。 */}
          <Route path="/system/rate-limits" element={<RateLimits />} />
          {/* 删除记录（#29 切片 2）：软删台账的查看与恢复；服务端 audit.read 同门
              （与审计日志同一批读者），恢复不改写历史——台账行原地补 restored_*，
              页面把这条说在前头。 */}
          <Route path="/system/deleted-records" element={<DeletedRecords />} />
          {/* 编号规则（#225）：配置工作室的编号配置面；服务端 numbering.configure
              门，改格式只影响之后发出的号——页面把这条说在前头。 */}
          <Route path="/system/numbering" element={<NumberingRules />} />
          {/* 流程模板（#220）：配置工作室的流程配置面；服务端 workflow.configure
              门，定义 JSON 编辑 + 实时流程图预览，四道保存门在服务端——预览画得
              出来不等于保存过得去。 */}
          <Route path="/system/workflows" element={<WorkflowTemplates />} />
          {/* 规则注册表（#233）：配置工作室的规则面；读面全公司可见（业务参数
              不是敏感数据），改权逐规则裁决——页面把 403 的角色与 400 的逐格
              编译错误原样说话；硬底线在代码里，本页无「新建」。 */}
          <Route path="/system/rules" element={<RulesRegistry />} />
          {/* 审批线（#221）：配置工作室的审批配置面；服务端 approval.configure
              门，就地改写与停用走 #226 版本台账——键永不复用，编辑只影响之后
              提交的请求，在飞的带着提交时刻的级别快照。 */}
          <Route path="/system/approvals" element={<ApprovalConfigs />} />
          {/* 自动化规则（#224）：配置工作室的自动化面；服务端 automations.configure
              门，保存即生效（worker 扫描器每周期读 enabled 规则，没有发布开关），
              runs 执行日志与 #226 版本史/回滚同页——删掉的规则日志仍在。 */}
          <Route path="/system/automations" element={<Automations />} />
          {/* 自定义字段（#222）：配置工作室的字段面；服务端 custom_fields.configure
              门，键与对象是身份永不改写、改内容走 #226 版本台账——已写入的值不随
              改型重写，页面把这条说在前头。 */}
          <Route path="/system/custom-fields" element={<CustomFields />} />
          {/* 2FA 自助（#24）：强制门把未绑定的管理员引到这里的合同,绑定流程
              本身不需要新的 API 面——走的都是 /api/auth/two-factor/*。 */}
          <Route path="/settings/two-factor" element={<TwoFactorSettings />} />
          {/* 通知渠道偏好（#116）：铃铛下拉直达；应用内是本体常开，页面只管
              额外渠道（首个 = 邮件摘要）。 */}
          <Route path="/settings/notifications" element={<NotificationSettings />} />
          {/* An address the router cannot reach is answered by the place a
              signed-in operator belongs — the same destination the index
              route picks. */}
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
