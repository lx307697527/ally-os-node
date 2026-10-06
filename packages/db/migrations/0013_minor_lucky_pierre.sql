CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"template_id" uuid,
	"template_key" text NOT NULL,
	"definition" jsonb NOT NULL,
	"current_state" text NOT NULL,
	"state_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state_due_at" timestamp with time zone,
	"started_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"template_key" text NOT NULL,
	"product_type" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"definition" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"event" text NOT NULL,
	"note" text,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_started_by_id_auth_user_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_transitions" ADD CONSTRAINT "workflow_transitions_actor_id_auth_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_instances_subject_idx" ON "workflow_instances" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "workflow_instances_due_idx" ON "workflow_instances" USING btree ("state_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_templates_key_idx" ON "workflow_templates" USING btree ("subject_type","template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_templates_default_idx" ON "workflow_templates" USING btree ("subject_type") WHERE is_default;--> statement-breakpoint
CREATE INDEX "workflow_templates_resolution_idx" ON "workflow_templates" USING btree ("subject_type","active");--> statement-breakpoint
CREATE INDEX "workflow_transitions_instance_idx" ON "workflow_transitions" USING btree ("instance_id","created_at");--> statement-breakpoint

-- 流转历史 append-only（#220，手写段——drizzle 不产触发器）：状态机历史是
-- 「发生过的事实」，改写或抹掉都不存在合法业务路径（回到过去 = 新的流转行，
-- 交给属主域表达），无条件拒绝行级 UPDATE/DELETE——与 audit_events（0007）、
-- esign_signatures（0012）同一裁决。
--
-- 测试清库走 TRUNCATE（DDL，不触发行触发器）——生产代码没有这条路。
CREATE OR REPLACE FUNCTION workflow_transitions_is_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'workflow_transitions is append-only: % is not permitted (#220)', tg_op
    USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER workflow_transitions_no_update
  BEFORE UPDATE ON "workflow_transitions"
  FOR EACH ROW EXECUTE FUNCTION workflow_transitions_is_immutable();

CREATE TRIGGER workflow_transitions_no_delete
  BEFORE DELETE ON "workflow_transitions"
  FOR EACH ROW EXECUTE FUNCTION workflow_transitions_is_immutable();