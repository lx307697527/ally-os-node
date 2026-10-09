import { Hono } from "hono";
import type { Db } from "@ally/db";
import { pdfTemplateConfigSchema, type PdfTemplateConfig } from "@ally/pdf";
import type { Logger } from "pino";
import type { AppEnv } from "../auth/session.ts";
import { requirePermission } from "../authz/middleware.ts";
import { recordAudit } from "../audit/audit-log.ts";
import { loadPdfTemplate, savePdfTemplate } from "../billing/pdf.ts";

/**
 * PDF 模板配置端点（#128 统一 PDF 生成服务）。
 *
 * 配置是**品牌与收款信息的展示事实**，不是业务状态：GET 回当前生效配置
 * （行不在 = 未配置 = 包内 DEFAULT），PATCH 收完整对象（strict，无实效变更
 * 幂等返回不留审计——与 approval/numbering PATCH 同一纪律）。渲染面（发票
 * PDF）从这里读，存档的票带模板快照，不受之后变更影响。
 *
 * 权限挂 `invoices.manage`（财务/老板）：收款指示是银行账户信息，出单据的
 * 品牌面是财务的脸面——不是任意的品牌配置点。配置工作室的模板管理 UI
 * （#225 剩余）进场时沿用同一权限点。
 *
 * 不进 config-revisions（#226）：模板是即改即生效的单行配置，没有「先审
 * 后上」的消费需求；审计（pdf.template_updated）承担可追溯，模板快照承担
 * 「当时长什么样」的自证。需要版本化时在同一裁决下重估，schema expand。
 */

/** 逐字段 diff（嵌套展开到叶子路径），存档审计的 from/to 与幂等判定共用 */
function flattenConfig(config: PdfTemplateConfig): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  flat.set("brandColor", config.brandColor);
  flat.set("company.name", config.company.name);
  flat.set("company.email", config.company.email);
  flat.set("company.phone", config.company.phone ?? null);
  const addressLines = [...config.company.addressLines];
  flat.set("company.addressLines", addressLines);
  flat.set("paymentInstructions.bankName", config.paymentInstructions.bankName);
  flat.set("paymentInstructions.accountName", config.paymentInstructions.accountName);
  flat.set("paymentInstructions.accountNumber", config.paymentInstructions.accountNumber);
  flat.set("paymentInstructions.routingNumber", config.paymentInstructions.routingNumber ?? null);
  flat.set("paymentInstructions.referenceNote", config.paymentInstructions.referenceNote ?? null);
  return flat;
}

export function pdfTemplateConfigRoutes(deps: { db: Db; logger: Logger }) {
  const app = new Hono<AppEnv>();

  app.get("/api/pdf-template-config", requirePermission("invoices.manage"), async (c) => {
    return c.json({ config: await loadPdfTemplate(deps.db) });
  });

  app.patch("/api/pdf-template-config", requirePermission("invoices.manage"), async (c) => {
    const parsed = pdfTemplateConfigSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const actorId = c.get("user").id;
    const before = flattenConfig(await loadPdfTemplate(deps.db));
    const after = flattenConfig(parsed.data);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const [key, value] of after) {
      const previous = before.get(key);
      if (JSON.stringify(previous) !== JSON.stringify(value)) {
        changes[key] = { from: previous ?? null, to: value };
      }
    }
    if (Object.keys(changes).length === 0) {
      return c.json({ config: parsed.data, updated: false });
    }
    await deps.db.transaction(async (tx) => {
      await savePdfTemplate(tx, parsed.data, actorId);
      await recordAudit(tx, {
        actor: actorId,
        action: "pdf.template_updated",
        target: "pdf_template_config",
        detail: { changes },
      });
    });
    deps.logger.info({ actor: actorId, fields: Object.keys(changes) }, "pdf template updated");
    return c.json({ config: parsed.data, updated: true });
  });

  return app;
}
