CREATE TABLE "comment_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"comment_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"storage_key" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comment_attachments" ADD CONSTRAINT "comment_attachments_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_attachments" ADD CONSTRAINT "comment_attachments_uploaded_by_auth_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_attachments_comment_idx" ON "comment_attachments" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comment_attachments_key_idx" ON "comment_attachments" USING btree ("storage_key");