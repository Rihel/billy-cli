import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `ai_tools.category`：类别冗余列（`core` / `business`），由种子同步从代码声明写过来。
 *
 * 为什么加它：后台页要按类别筛选 —— 类别只在代码声明里，不落列就没法在 SQL 里筛，
 * 只能"先分页再过滤"（那样分页就是假的）。它是**声明说了算**的列，人工改不了。
 */

export class AiToolCategory1790823982451 implements MigrationInterface {
  name = 'AiToolCategory1790823982451'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_tools" ADD "category" character varying(16) NOT NULL DEFAULT 'core'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "category"`)
  }
}
