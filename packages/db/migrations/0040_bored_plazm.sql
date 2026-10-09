CREATE TABLE "rate_limit_counters" (
	"identifier_type" text NOT NULL,
	"identifier" text NOT NULL,
	"action" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_limit_counters_identifier_type_identifier_action_window_start_pk" PRIMARY KEY("identifier_type","identifier","action","window_start")
);
--> statement-breakpoint
CREATE TABLE "rate_limit_denials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier_type" text NOT NULL,
	"identifier" text NOT NULL,
	"action" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count_at_denial" integer NOT NULL,
	"limit_value" integer NOT NULL,
	"request_id" text,
	"denied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_counters_window_start_idx" ON "rate_limit_counters" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "rate_limit_denials_denied_at_idx" ON "rate_limit_denials" USING btree ("denied_at");--> statement-breakpoint
CREATE INDEX "rate_limit_denials_identifier_idx" ON "rate_limit_denials" USING btree ("identifier_type","identifier","denied_at");