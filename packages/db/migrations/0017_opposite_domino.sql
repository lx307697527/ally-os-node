CREATE TYPE "public"."numbering_date_format" AS ENUM('YYYY', 'YYYYMM', 'YYYYMMDD');--> statement-breakpoint
CREATE TABLE "numbering_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"label" text NOT NULL,
	"prefix" text DEFAULT '' NOT NULL,
	"date_format" "numbering_date_format",
	"padding" integer DEFAULT 4 NOT NULL,
	"start_number" bigint DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "numbering_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"last_issued" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "numbering_rules" ADD CONSTRAINT "numbering_rules_created_by_id_auth_user_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."auth_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numbering_sequences" ADD CONSTRAINT "numbering_sequences_rule_id_numbering_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."numbering_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "numbering_rules_active_subject_idx" ON "numbering_rules" USING btree ("subject") WHERE "numbering_rules"."active";--> statement-breakpoint
CREATE UNIQUE INDEX "numbering_sequences_rule_idx" ON "numbering_sequences" USING btree ("rule_id");