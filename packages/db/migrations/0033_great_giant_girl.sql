ALTER TABLE "payments" ADD COLUMN "surcharge_cents" integer;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_surcharge_positive" CHECK ("payments"."surcharge_cents" > 0);