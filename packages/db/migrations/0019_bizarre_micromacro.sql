CREATE TYPE "public"."config_revision_source" AS ENUM('created', 'updated', 'rolled_back');--> statement-breakpoint
CREATE TABLE "config_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"changes" jsonb,
	"source" "config_revision_source" NOT NULL,
	"changed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_revisions" ADD CONSTRAINT "config_revisions_changed_by_id_auth_user_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_revisions_version_idx" ON "config_revisions" USING btree ("subject_type","subject_id","version");--> statement-breakpoint
CREATE INDEX "config_revisions_subject_idx" ON "config_revisions" USING btree ("subject_type","subject_id");--> statement-breakpoint
-- 存量配置行补账（手写段）：五族配置在台账进场前已有行（staging 已在跑），
-- 台账是回滚的唯一事实来源，行没账 = 不可回滚也不可读史。补账把每行现状按
-- 当前 version 入账（source 'created'，快照与本迁移时刻配置面的写入形状逐一
-- 同构——config-versions/families.ts 是 TS 侧的同一契约）。台账前的演进史
-- （automation_rules 靠「spec 变更 +1」到过 >1 的版本）无法逐版重建，一律以
-- 补账时刻现状为一版事实——版本连续性自此由写入侧同事务记账保证，不再有账外变更。
INSERT INTO "config_revisions" ("subject_type", "subject_id", "version", "snapshot", "changes", "source", "changed_by_id", "created_at")
SELECT 'workflow_template', t."id", t."version",
  jsonb_build_object('productType', t."product_type", 'isDefault', t."is_default", 'active', t."active", 'definition', t."definition"),
  NULL, 'created', t."created_by_id", t."created_at"
FROM "workflow_templates" t;--> statement-breakpoint
INSERT INTO "config_revisions" ("subject_type", "subject_id", "version", "snapshot", "changes", "source", "changed_by_id", "created_at")
SELECT 'approval_config', c."id", c."version",
  jsonb_build_object('name', c."name", 'levels', c."levels", 'active', c."active"),
  NULL, 'created', c."created_by_id", c."created_at"
FROM "approval_configs" c;--> statement-breakpoint
INSERT INTO "config_revisions" ("subject_type", "subject_id", "version", "snapshot", "changes", "source", "changed_by_id", "created_at")
SELECT 'custom_field_def', d."id", d."version",
  jsonb_build_object('label', d."label", 'fieldType', d."field_type", 'options', d."options", 'required', d."required", 'viewableBy', d."viewable_by", 'editableBy', d."editable_by", 'active', d."active"),
  NULL, 'created', d."created_by_id", d."created_at"
FROM "custom_field_defs" d;--> statement-breakpoint
INSERT INTO "config_revisions" ("subject_type", "subject_id", "version", "snapshot", "changes", "source", "changed_by_id", "created_at")
SELECT 'automation_rule', r."id", r."version",
  jsonb_build_object('name', r."name", 'description', r."description", 'trigger', r."trigger", 'conditions', r."conditions", 'actions', r."actions", 'enabled', r."enabled"),
  NULL, 'created', r."created_by_id", r."created_at"
FROM "automation_rules" r;--> statement-breakpoint
INSERT INTO "config_revisions" ("subject_type", "subject_id", "version", "snapshot", "changes", "source", "changed_by_id", "created_at")
SELECT 'numbering_rule', n."id", n."version",
  jsonb_build_object('label', n."label", 'prefix', n."prefix", 'dateFormat', n."date_format", 'padding', n."padding", 'active', n."active"),
  NULL, 'created', n."created_by_id", n."created_at"
FROM "numbering_rules" n;--> statement-breakpoint
-- 配置版本台账 append-only（手写段——drizzle 不产触发器）：台账是「配置曾经
-- 是什么样」的事实流水，回滚 = 按历史快照写入一个**新**版本，改写/删除任何
-- 版本都不存在合法业务路径（#226 验收「查看版本历史」的前提是历史不可变）。
-- 无条件拒绝行级 UPDATE/DELETE——与 audit_events（0007）、esign_signatures
-- （0012）、workflow_transitions（0013）、approval_actions（0014）同一裁决。
--
-- 测试清库走 TRUNCATE（DDL，不触发行触发器）——生产代码没有这条路。
CREATE OR REPLACE FUNCTION config_revisions_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'config_revisions is append-only: % is not permitted (#226)', tg_op
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER config_revisions_no_update
  BEFORE UPDATE ON "config_revisions"
  FOR EACH ROW EXECUTE FUNCTION config_revisions_is_immutable();

CREATE TRIGGER config_revisions_no_delete
  BEFORE DELETE ON "config_revisions"
  FOR EACH ROW EXECUTE FUNCTION config_revisions_is_immutable();