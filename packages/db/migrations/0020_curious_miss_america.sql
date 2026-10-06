ALTER TYPE "public"."config_revision_source" ADD VALUE 'published';--> statement-breakpoint
CREATE TABLE "config_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"content" jsonb NOT NULL,
	"base_version" integer NOT NULL,
	"note" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "config_drafts" ADD CONSTRAINT "config_drafts_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_drafts" ADD CONSTRAINT "config_drafts_updated_by_id_auth_user_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_drafts_subject_idx" ON "config_drafts" USING btree ("subject_type","subject_id");