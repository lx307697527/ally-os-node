DROP INDEX "auth_user_email_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "auth_user_email_idx" ON "auth_user" USING btree (lower("email"));