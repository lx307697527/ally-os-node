CREATE TABLE "deleted_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"title" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"restored_by" uuid,
	"restored_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_deleted_by_auth_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deleted_records" ADD CONSTRAINT "deleted_records_restored_by_auth_user_id_fk" FOREIGN KEY ("restored_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deleted_records_active_unique" ON "deleted_records" USING btree ("subject_type","subject_id") WHERE restored_at is null;--> statement-breakpoint
CREATE INDEX "deleted_records_deleted_at_idx" ON "deleted_records" USING btree ("deleted_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deleted_by_auth_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;