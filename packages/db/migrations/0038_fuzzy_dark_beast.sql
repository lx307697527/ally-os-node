CREATE TYPE "public"."credit_note_status" AS ENUM('draft', 'issued', 'void');--> statement-breakpoint
CREATE TABLE "credit_note_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"line_total_cents" integer GENERATED ALWAYS AS (round(quantity * unit_price_cents)) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"status" "credit_note_status" DEFAULT 'draft' NOT NULL,
	"reason" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"issued_at" timestamp with time zone,
	"issued_by_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_id" uuid,
	"void_reason" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_note_lines" ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."credit_notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_issued_by_id_auth_user_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_voided_by_id_auth_user_id_fk" FOREIGN KEY ("voided_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_note_lines_credit_note_id_idx" ON "credit_note_lines" USING btree ("credit_note_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_notes_number_idx" ON "credit_notes" USING btree ("number");--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_id_idx" ON "credit_notes" USING btree ("invoice_id");