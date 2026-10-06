ALTER TABLE "tasks" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "subject_id" uuid;--> statement-breakpoint
CREATE INDEX "tasks_subject_idx" ON "tasks" USING btree ("subject_type","subject_id");