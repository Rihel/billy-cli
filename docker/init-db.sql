-- 数据库初始化脚本（由 PostgreSQL 容器首次启动时自动执行）
-- 对应 drizzle migration 顺序：
--   1. 20260723072501_black_maelstrom  → todos
--   2. 20260723091534_chubby_sway      → users
--   3. 20260723093009_lazy_the_initiative → users alter

CREATE TABLE IF NOT EXISTS "todos" (
  "id"          varchar      PRIMARY KEY,
  "created_at"  timestamp    DEFAULT now() NOT NULL,
  "updated_at"  timestamp    DEFAULT now() NOT NULL,
  "title"       text         NOT NULL,
  "description" text,
  "completed"   boolean      DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS "users" (
  "id"                          varchar   PRIMARY KEY,
  "created_at"                  timestamp DEFAULT now() NOT NULL,
  "updated_at"                  timestamp DEFAULT now() NOT NULL,
  "email"                       text      NOT NULL UNIQUE,
  "password"                    text      NOT NULL,
  "real_name"                   text,
  "avatar"                      text,
  "reset_password_token"        text,
  "reset_password_token_expiry" timestamp
);

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar" text;

ALTER TABLE "todos"
  ALTER COLUMN "created_at" TYPE timestamp(3),
  ALTER COLUMN "updated_at" TYPE timestamp(3);
ALTER TABLE "users"
  ALTER COLUMN "created_at" TYPE timestamp(3),
  ALTER COLUMN "updated_at" TYPE timestamp(3);

CREATE TABLE IF NOT EXISTS "admins" (
  "id"         varchar      PRIMARY KEY,
  "created_at" timestamp(3) DEFAULT now() NOT NULL,
  "updated_at" timestamp(3) DEFAULT now() NOT NULL,
  "deleted_at" timestamp(3),
  "email"      text         NOT NULL,
  "password"   text         NOT NULL,
  "real_name"  text,
  "avatar"     text,
  "status"     varchar(20)  DEFAULT 'enabled' NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_admin_email" ON "admins" ("email", "deleted_at");
