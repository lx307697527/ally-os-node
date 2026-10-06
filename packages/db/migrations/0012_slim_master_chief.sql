CREATE TYPE "public"."esignature_meaning" AS ENUM('performed', 'reviewed', 'approved');--> statement-breakpoint
CREATE TABLE "esign_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"signer_id" uuid NOT NULL,
	"meaning" "esignature_meaning" NOT NULL,
	"record_version" text NOT NULL,
	"record_hash" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_token" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "esign_signatures" ADD CONSTRAINT "esign_signatures_signer_id_auth_user_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "esign_signatures_subject_idx" ON "esign_signatures" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "esign_signatures_signer_meaning_idx" ON "esign_signatures" USING btree ("subject_type","subject_id","signer_id","meaning");--> statement-breakpoint
CREATE UNIQUE INDEX "esign_signatures_client_token_idx" ON "esign_signatures" USING btree ("client_token");

-- ── #219：电子签名行 append-only ────────────────────────────────────────────
-- Part 11.200「签名与记录不可改写」：签名行被改写或抹掉时不存在任何合法业务
-- 路径（更正走新记录/变更流程，#219 正文原句），所以无条件拒绝——与 audit_events
-- 的 0007 同一裁决（fix747/fix906 直译）。drizzle 生成不了触发器，DDL 随本
-- migration 手写；本 migration 尚未合并，手写合法。
--
-- 测试清库走 TRUNCATE（DDL，不触发行触发器）——生产代码没有这条路。
CREATE OR REPLACE FUNCTION esign_signatures_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'esign_signatures is append-only: % is not permitted (#219)', tg_op
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER esign_signatures_no_update
  BEFORE UPDATE ON "esign_signatures"
  FOR EACH ROW EXECUTE FUNCTION esign_signatures_is_immutable();

CREATE TRIGGER esign_signatures_no_delete
  BEFORE DELETE ON "esign_signatures"
  FOR EACH ROW EXECUTE FUNCTION esign_signatures_is_immutable();