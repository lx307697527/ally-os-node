CREATE TABLE "error_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fingerprint" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"url" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_spikes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"event_count" integer NOT NULL,
	"threshold" integer NOT NULL,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "error_events_fingerprint_created_at_idx" ON "error_events" USING btree ("fingerprint","created_at" desc);--> statement-breakpoint
CREATE INDEX "error_events_created_at_idx" ON "error_events" USING btree ("created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "error_spikes_window_start_key" ON "error_spikes" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "error_spikes_alerted_at_idx" ON "error_spikes" USING btree ("alerted_at");