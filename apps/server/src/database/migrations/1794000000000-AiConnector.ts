import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * 连接器实例表 + `ai_tools` 的来源列（设计 `docs/design/ai-connector.md` §3.2）。
 *
 * 三条要点（人工核对过）：
 * - `ai_connectors` 的唯一键是**软删感知的部分索引**（`uk_connector_key ... WHERE deleted_at IS NULL`），
 *   与 `ai_tools` 同一口径，否则软删后同 key 无法重建；
 * - `ai_tools` 加三列：`origin`（code / connector，默认 code，存量行自动正确）、
 *   `connector_id`（指向实例，**不加外键**，遵守工程硬规则）、`remote_tool_name`（对方原名）；
 * - 工具 key 仍全局唯一（沿用 `uk_tool_key`），连接器工具的前缀只是可读约定，**追溯只认 `connector_id`**。
 */

export class AiConnector1794000000000 implements MigrationInterface {
    name = 'AiConnector1794000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_connectors" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "key" character varying(32) NOT NULL, "name" character varying(64) NOT NULL, "driver" character varying(32) NOT NULL, "kind" character varying(16) NOT NULL DEFAULT 'builtin', "transport" character varying(16) NOT NULL DEFAULT 'none', "auth_base" character varying(16) NOT NULL DEFAULT 'none', "auth_subject" character varying(16) NOT NULL DEFAULT 'none', "config" jsonb, "secrets" jsonb, "enabled" boolean NOT NULL DEFAULT true, "status" character varying(16) NOT NULL DEFAULT 'unknown', "last_error" text, "last_checked_at" TIMESTAMP(3), "tool_count" integer NOT NULL DEFAULT 0, "allowed_tools" jsonb, CONSTRAINT "PK_ai_connectors" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "uk_connector_key" ON "ai_connectors" ("key") WHERE deleted_at IS NULL`);
        await queryRunner.query(`CREATE INDEX "idx_connector_enabled" ON "ai_connectors" ("enabled")`);

        await queryRunner.query(`ALTER TABLE "ai_tools" ADD "origin" character varying(16) NOT NULL DEFAULT 'code'`);
        await queryRunner.query(`ALTER TABLE "ai_tools" ADD "connector_id" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "ai_tools" ADD "remote_tool_name" character varying(128)`);
        await queryRunner.query(`CREATE INDEX "idx_tool_connector" ON "ai_tools" ("connector_id")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_tool_connector"`);
        await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "remote_tool_name"`);
        await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "connector_id"`);
        await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "origin"`);

        await queryRunner.query(`DROP INDEX "public"."idx_connector_enabled"`);
        await queryRunner.query(`DROP INDEX "public"."uk_connector_key"`);
        await queryRunner.query(`DROP TABLE "ai_connectors"`);
    }

}
