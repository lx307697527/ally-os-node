CREATE TYPE "public"."feedback_report_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."feedback_report_status" AS ENUM('pending', 'in_review', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."feedback_report_type" AS ENUM('bug_report', 'feature_request', 'process_gap');--> statement-breakpoint
CREATE TABLE "feedback_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_number" text NOT NULL,
	"type" "feedback_report_type" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"steps_to_reproduce" text,
	"priority" "feedback_report_priority" NOT NULL,
	"status" "feedback_report_status" DEFAULT 'pending' NOT NULL,
	"submitted_by_user_id" uuid NOT NULL,
	"submitter_name" text NOT NULL,
	"submitter_email" text NOT NULL,
	"admin_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text,
	"aggregate_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback_reports" ADD CONSTRAINT "feedback_reports_submitted_by_user_id_auth_user_id_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_reports_number_idx" ON "feedback_reports" USING btree ("report_number");--> statement-breakpoint
CREATE INDEX "notifications_user_recent_idx" ON "notifications" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id") WHERE "notifications"."is_read" = false;