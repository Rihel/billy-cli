import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * `ai_providers.slug`：模型对外标识的前半段（`<slug>/<modelKey>`，也是 Mastra 认识的
 * `provider/model` 形态）。
 *
 * 两条要点（生成后手工核对过）：
 * - `slug` **NOT NULL**：建表时表为空，无需回填、也不给默认值，由服务层保证合法；
 * - 唯一索引 `uk_provider_slug` 是**部分索引**（`WHERE deleted_at IS NULL`）—— 与
 *   `uk_provider_name` 同一口径，否则软删后 slug 无法复用。
 *   TypeORM 对部分索引的**条件变化**检测不到，所以条件必须人工核对（本文件已核对）。
 */
export class AiProviderSlug1790182877419 implements MigrationInterface {
  name = 'AiProviderSlug1790182877419'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_providers" ADD "slug" character varying(32) NOT NULL`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_provider_slug" ON "ai_providers" ("slug") WHERE deleted_at IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_provider_slug"`)
    await queryRunner.query(`ALTER TABLE "ai_providers" DROP COLUMN "slug"`)
  }
}
