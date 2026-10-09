CREATE TABLE "invoice_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_sha256" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"template_snapshot" jsonb NOT NULL,
	"generated_by_id" uuid,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pdf_template_config" (
	"id" integer PRIMARY KEY NOT NULL,
	"brand_color" text NOT NULL,
	"company_name" text NOT NULL,
	"company_address_lines" jsonb NOT NULL,
	"company_email" text NOT NULL,
	"company_phone" text,
	"bank_name" text NOT NULL,
	"bank_account_name" text NOT NULL,
	"bank_account_number" text NOT NULL,
	"bank_routing_number" text,
	"payment_reference_note" text,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_generated_by_id_auth_user_id_fk" FOREIGN KEY ("generated_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pdf_template_config" ADD CONSTRAINT "pdf_template_config_updated_by_id_auth_user_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_invoice_id_idx" ON "invoice_documents" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_documents_key_idx" ON "invoice_documents" USING btree ("storage_key");