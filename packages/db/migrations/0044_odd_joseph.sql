CREATE TABLE "system_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"subject_template" text,
	"body_template" text NOT NULL,
	"changed_by_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"template_type" text NOT NULL,
	"subject_template" text,
	"body_template" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_template_versions" ADD CONSTRAINT "system_template_versions_template_id_system_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."system_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_template_versions" ADD CONSTRAINT "system_template_versions_changed_by_id_auth_user_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_templates" ADD CONSTRAINT "system_templates_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_templates" ADD CONSTRAINT "system_templates_updated_by_id_auth_user_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "system_template_versions_template_version_idx" ON "system_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "system_templates_channel_type_idx" ON "system_templates" USING btree ("channel","template_type");