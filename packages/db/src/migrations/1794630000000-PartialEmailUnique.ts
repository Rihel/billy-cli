import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 邮箱唯一：`UNIQUE(email, deleted_at)` → **部分唯一索引** `UNIQUE(email) WHERE deleted_at IS NULL`。
 *
 * 原写法在 PostgreSQL 下挡不住「同一邮箱多个活用户」：软删行的 `deleted_at` 非空，
 * 但活动行都是 NULL，而 NULL 互不相等 —— 唯一约束对它们形同虚设。
 * （2026-11-14 评审：P1-7，users 与 admins 两张表同时整改。）
 *
 * 若库里已有重复的活邮箱，本迁移会**失败并指出问题**（不静默删数据），先人工合并再重跑。
 */
export class PartialEmailUnique1794630000000 implements MigrationInterface {
  name = 'PartialEmailUnique1794630000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "uk_user_email"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_user_email" ON "users" ("email") WHERE "deleted_at" IS NULL`,
    )
    await queryRunner.query(`ALTER TABLE "admins" DROP CONSTRAINT IF EXISTS "uk_admin_email"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_admin_email" ON "admins" ("email") WHERE "deleted_at" IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uk_admin_email"`)
    await queryRunner.query(
      `ALTER TABLE "admins" ADD CONSTRAINT "uk_admin_email" UNIQUE ("email", "deleted_at")`,
    )
    await queryRunner.query(`DROP INDEX IF EXISTS "uk_user_email"`)
    await queryRunner.query(
      `ALTER TABLE "users" ADD CONSTRAINT "uk_user_email" UNIQUE ("email", "deleted_at")`,
    )
  }
}
