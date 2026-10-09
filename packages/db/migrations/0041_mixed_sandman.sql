CREATE TYPE "public"."file_status" AS ENUM('pending', 'ready');--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_auth_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."auth_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_subject_idx" ON "files" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_key_idx" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_pending_created_idx" ON "files" USING btree ("created_at") WHERE status = 'pending';