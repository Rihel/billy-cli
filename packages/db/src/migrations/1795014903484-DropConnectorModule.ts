import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 删除连接器模块（2026-11-18 决定）：
 *
 * - `ai_connectors` 整表删除（连接器配置与密钥一起丢，不可恢复）；
 * - `ai_tools` 上只服务连接器的三列（`origin` / `connector_id` / `remote_tool_name`）与其索引删除；
 * - 连接器产出的工具行随 `origin='connector'` 一起清掉——模块没了，这些行没有生产者。
 *
 * 能力侧改由能力网关承接（external-access 服务 / MCP 适配器，见能力协议 §3.7）。
 */
export class DropConnectorModule1795014903484 implements MigrationInterface {
  name = 'DropConnectorModule1795014903484'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 全量新库不会经过被删掉的连接器迁移：所有动作都按「存在才做」，两种库都能跑
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'ai_tools' AND column_name = 'origin'
        ) THEN
          DELETE FROM "ai_tools" WHERE "origin" = 'connector';
        END IF;
      END $$;
    `)
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_tool_connector"`)
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN IF EXISTS "origin"`)
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN IF EXISTS "connector_id"`)
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN IF EXISTS "remote_tool_name"`)
    await queryRunner.query(`DROP TABLE IF EXISTS "public"."ai_connectors"`)
  }

  /** down 只能把结构建回来（表数据与连接器密钥已丢），用于回滚部署而不是恢复数据 */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_tools" ADD COLUMN IF NOT EXISTS "remote_tool_name" character varying(128)`,
    )
    await queryRunner.query(
      `ALTER TABLE "ai_tools" ADD COLUMN IF NOT EXISTS "connector_id" character varying(20)`,
    )
    await queryRunner.query(
      `ALTER TABLE "ai_tools" ADD COLUMN IF NOT EXISTS "origin" character varying(16) NOT NULL DEFAULT 'code'`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_tool_connector" ON "ai_tools" USING btree ("connector_id")`,
    )
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "ai_connectors" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "key" character varying(32) NOT NULL, "name" character varying(64) NOT NULL, "driver" character varying(32) NOT NULL, "kind" character varying(16) NOT NULL DEFAULT 'builtin', "transport" character varying(16) NOT NULL DEFAULT 'none', "auth_base" character varying(16) NOT NULL DEFAULT 'none', "auth_subject" character varying(16) NOT NULL DEFAULT 'none', "config" jsonb, "secrets" jsonb, "enabled" boolean NOT NULL DEFAULT true, "status" character varying(16) NOT NULL DEFAULT 'unknown', "last_error" text, "last_checked_at" TIMESTAMP(3), "tool_count" integer NOT NULL DEFAULT 0, "allowed_tools" jsonb, "catalog_kind" character varying(32) NOT NULL DEFAULT '', "auth_state" jsonb, "auth_state_version" integer NOT NULL DEFAULT 0, CONSTRAINT "PK_ai_connectors" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_connector_key" ON "ai_connectors" ("key") WHERE deleted_at IS NULL`,
    )
  }
}
