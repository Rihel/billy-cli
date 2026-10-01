import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * `ai_tools`：AI 工具配置表（设计 `docs/design/ai-agent-tool-engine.md` §5.5）。
 *
 * 三条要点（生成后手工核对过）：
 * - **唯一键是软删感知的部分索引**（`uk_tool_key ... WHERE deleted_at IS NULL`）——
 *   与 `ai_models` / `ai_providers` 同一口径，否则软删后同 key 无法重建；
 *   TypeORM 检测不到部分索引的**条件变化**，条件必须人工核对（本文件已核对）；
 * - `config` / `limits` / `secrets_*` / `allowed_agents` 都是 jsonb 且可空：
 *   配置值允许稀疏（默认值在代码里），秘钥存密文 + 提示串；
 * - `source` 默认 `seed`：种子同步来的行会被更新，`manual`（人工改过）不会被覆盖。
 */

export class AiToolConfig1790823761713 implements MigrationInterface {
    name = 'AiToolConfig1790823761713'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "ai_tools" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "tool_key" character varying(64) NOT NULL, "title" character varying(128), "description" text, "enabled" boolean NOT NULL DEFAULT true, "scope" character varying(16) NOT NULL DEFAULT 'all', "allowed_agents" jsonb, "config" jsonb, "secrets_cipher" jsonb, "secrets_hint" jsonb, "limits" jsonb, "source" character varying(16) NOT NULL DEFAULT 'seed', "last_seen_at" TIMESTAMP(3), CONSTRAINT "PK_89bd82d253d0be3420956640296" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_tool_enabled" ON "ai_tools"  ("enabled") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uk_tool_key" ON "ai_tools"  ("tool_key") WHERE deleted_at IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."uk_tool_key"`);
        await queryRunner.query(`DROP INDEX "public"."idx_tool_enabled"`);
        await queryRunner.query(`DROP TABLE "ai_tools"`);
    }

}
