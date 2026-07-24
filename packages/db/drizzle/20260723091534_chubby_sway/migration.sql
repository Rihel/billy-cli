CREATE TABLE "users" (
	"id" varchar PRIMARY KEY,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"email" text NOT NULL UNIQUE,
	"password" text NOT NULL,
	"real_name" text
);
