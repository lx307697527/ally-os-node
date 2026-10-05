CREATE TYPE "public"."app_role" AS ENUM('owner', 'admin', 'sales_lead', 'sales', 'customer_service', 'sales_assistant', 'ops_assistant', 'formulator', 'purchaser', 'warehouse', 'production_lead', 'qa', 'lab_technician', 'finance', 'customer');--> statement-breakpoint
CREATE TABLE "user_permission" (
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_permission_user_id_permission_pk" PRIMARY KEY("user_id","permission")
);
--> statement-breakpoint
CREATE TABLE "user_role" (
	"user_id" uuid NOT NULL,
	"role" "app_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_user_id_role_pk" PRIMARY KEY("user_id","role")
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "target" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "detail" jsonb;--> statement-breakpoint
ALTER TABLE "user_permission" ADD CONSTRAINT "user_permission_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_permission_permission_idx" ON "user_permission" USING btree ("permission");--> statement-breakpoint
CREATE INDEX "user_role_role_idx" ON "user_role" USING btree ("role");