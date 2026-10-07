CREATE TYPE "public"."rules_effect_digest_status" AS ENUM('pending', 'sent');--> statement-breakpoint
CREATE TABLE "rules_effect_digest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"week_end" timestamp with time zone NOT NULL,
	"status" "rules_effect_digest_status" DEFAULT 'pending' NOT NULL,
	"counters_at" jsonb NOT NULL,
	"entries" jsonb NOT NULL,
	"total_rules" integer NOT NULL,
	"recipients" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
