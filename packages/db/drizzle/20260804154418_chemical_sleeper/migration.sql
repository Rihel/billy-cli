ALTER TABLE "todos" ALTER COLUMN "created_at" SET DATA TYPE timestamp(3) USING "created_at"::timestamp(3);--> statement-breakpoint
ALTER TABLE "todos" ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3) USING "updated_at"::timestamp(3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "created_at" SET DATA TYPE timestamp(3) USING "created_at"::timestamp(3);--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "updated_at" SET DATA TYPE timestamp(3) USING "updated_at"::timestamp(3);