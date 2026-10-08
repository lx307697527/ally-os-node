ALTER TABLE "invoices" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "overdue_reminder_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "invoices_issued_due_idx" ON "invoices" USING btree ("due_at") WHERE status = 'issued' and due_at is not null;