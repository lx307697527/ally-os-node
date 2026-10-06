CREATE TYPE "public"."approval_decision" AS ENUM('approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "approval_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"level_name" text NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"note" text,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"config_key" text NOT NULL,
	"name" text NOT NULL,
	"levels" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"config_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"levels" jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"submitted_by_id" uuid NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_actions" ADD CONSTRAINT "approval_actions_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_configs" ADD CONSTRAINT "approval_configs_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_config_id_approval_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."approval_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_submitted_by_id_auth_user_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "approval_actions_request_step_idx" ON "approval_actions" USING btree ("request_id","step_index");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_configs_key_idx" ON "approval_configs" USING btree ("subject_type","config_key");--> statement-breakpoint
CREATE INDEX "approval_configs_resolution_idx" ON "approval_configs" USING btree ("subject_type","active");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_pending_idx" ON "approval_requests" USING btree ("subject_type","subject_id","config_key") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "approval_requests_todo_idx" ON "approval_requests" USING btree ("status","current_step");
-- 审批裁决流水 append-only（#221，手写段——drizzle 不产触发器）：审批记录是
-- 「发生过的事实」（#221 验收「审批记录可追溯：谁、何时、同意或驳回、意见」），
-- 改写或撤回都不存在合法业务路径——驳回到发起人是新请求，不是改旧裁决。无条件
-- 拒绝行级 UPDATE/DELETE——与 audit_events（0007）、esign_signatures（0012）、
-- workflow_transitions（0013）同一裁决。
--
-- 测试清库走 TRUNCATE（DDL，不触发行触发器）——生产代码没有这条路。
CREATE OR REPLACE FUNCTION approval_actions_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval_actions is append-only: % is not permitted (#221)', tg_op
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER approval_actions_no_update
  BEFORE UPDATE ON "approval_actions"
  FOR EACH ROW EXECUTE FUNCTION approval_actions_is_immutable();

CREATE TRIGGER approval_actions_no_delete
  BEFORE DELETE ON "approval_actions"
  FOR EACH ROW EXECUTE FUNCTION approval_actions_is_immutable();
