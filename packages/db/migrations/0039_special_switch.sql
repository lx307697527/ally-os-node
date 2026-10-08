ALTER TYPE "public"."invoice_type" ADD VALUE 'installment';--> statement-breakpoint
CREATE TABLE "invoice_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" text NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"total_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "plan_index" integer;--> statement-breakpoint
ALTER TABLE "invoice_plans" ADD CONSTRAINT "invoice_plans_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_plans_subject_idx" ON "invoice_plans" USING btree ("subject_type","subject_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_id_invoice_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."invoice_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_plan_id_idx" ON "invoices" USING btree ("plan_id");