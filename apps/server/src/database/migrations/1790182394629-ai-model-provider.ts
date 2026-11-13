import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * AI 模型模块的两张表（供应商 + 模型）。
 *
 * 表结构由实体定义（`ai-provider-entity.ts` / `ai-model-entity.ts`），本文件是生成结果；
 * 两条部分唯一索引（`WHERE deleted_at IS NULL`）是**刻意的**：这两张表是软删的配置类数据，
 * 唯一约束必须"软删感知"，否则删掉再建同名会被历史行挡住。
 */
export class AiModelProvider1790182394629 implements MigrationInterface {
  name = 'AiModelProvider1790182394629'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_models" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "provider_id" character varying(20) NOT NULL, "model_key" character varying(128) NOT NULL, "display_name" character varying(128) NOT NULL, "context_window" integer, "max_output_tokens" integer, "capabilities" jsonb, "source" character varying(16) NOT NULL DEFAULT 'sync', "enabled" boolean NOT NULL DEFAULT true, "last_seen_at" TIMESTAMP(3), "synced_at" TIMESTAMP(3), "raw" jsonb, CONSTRAINT "PK_3d254744f0bcf6f35be5826e25e" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_model_enabled" ON "ai_models"  ("enabled") `)
    await queryRunner.query(`CREATE INDEX "idx_model_provider" ON "ai_models"  ("provider_id") `)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_model_provider_key" ON "ai_models"  ("provider_id", "model_key") WHERE deleted_at IS NULL`,
    )
    await queryRunner.query(
      `CREATE TABLE "ai_providers" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "name" character varying(64) NOT NULL, "kind" character varying(32) NOT NULL DEFAULT 'openai-compatible', "base_url" character varying(255), "api_key_cipher" text, "api_key_hint" character varying(32), "enabled" boolean NOT NULL DEFAULT true, "last_synced_at" TIMESTAMP(3), "last_sync_error" text, "metadata" jsonb, CONSTRAINT "PK_de28ebefc0fb425c37b27a4c0a7" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_provider_enabled" ON "ai_providers"  ("enabled") `)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_provider_name" ON "ai_providers"  ("name") WHERE deleted_at IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_provider_name"`)
    await queryRunner.query(`DROP INDEX "public"."idx_provider_enabled"`)
    await queryRunner.query(`DROP TABLE "ai_providers"`)
    await queryRunner.query(`DROP INDEX "public"."uk_model_provider_key"`)
    await queryRunner.query(`DROP INDEX "public"."idx_model_provider"`)
    await queryRunner.query(`DROP INDEX "public"."idx_model_enabled"`)
    await queryRunner.query(`DROP TABLE "ai_models"`)
  }
}
