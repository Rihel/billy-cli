CREATE TABLE "todos" (
	"id" varchar PRIMARY KEY,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"completed" boolean DEFAULT false NOT NULL
);
