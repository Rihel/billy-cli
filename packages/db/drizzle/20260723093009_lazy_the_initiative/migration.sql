ALTER TABLE "users" ADD COLUMN "reset_password_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "reset_password_token_expiry" timestamp;