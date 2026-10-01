CREATE TABLE "realtime_presence" (
	"connection_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"user_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realtime_presence_connection_id_channel_id_pk" PRIMARY KEY("connection_id","channel_id")
);
--> statement-breakpoint
CREATE INDEX "realtime_presence_channel_idx" ON "realtime_presence" USING btree ("channel_id");