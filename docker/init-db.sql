-- 数据库初始化脚本（由 PostgreSQL 容器首次启动时自动执行，仅对**全新数据卷**生效）。
--
-- ⚠️ 本文件**不建任何业务表**。
--   schema 的唯一来源是 TypeORM 迁移：apps/server/src/database/migrations/，
--   由 `pnpm db:migrate` 执行（`pnpm bootstrap` 已包含该步骤）。
--
-- 为什么曾经是错的（别改回去）：本文件早期照 drizzle 时代的迁移建过 todos / users / admins，
--   而 TypeORM 的 initial 迁移用的是裸 `CREATE TABLE "todos"`（无 IF NOT EXISTS），
--   于是全新数据卷上 `docker compose up postgres` → `pnpm db:migrate` 会在 initial 迁移处
--   报 `relation "todos" already exists` 直接失败；且那几张表的形状与实体也不一致
--   （缺 deleted_at、主键名不同）。drizzle 早已移除，这段 DDL 属于旧栈残留。
--
-- 这里只保留「迁移表达不了、又必须建库时完成」的库级设置。
-- 扩展需要超级用户，放在这里而不是迁移里（迁移账号通常没有 DDL 权限）。
--
-- `vector`：长期记忆的语义检索（P2，embedding 接好后才用）；
-- `pg_trgm`：记忆 / 搜索的模糊匹配走索引（对应 database skill 的 ILIKE 与索引失效一节）。
-- 两者都必须 IF NOT EXISTS：本脚本只在**全新数据卷**执行一次。
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT 1;
