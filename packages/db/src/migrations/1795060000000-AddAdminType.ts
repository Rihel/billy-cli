import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 管理员类型（`docs/design/workspace-cli-credentials.md` §6.10 / §9.1）。
 *
 * 只加列 + 索引，**不写任何具体账号**：邮箱与密码无法跨环境复用，
 * 且账号被删后无法再次初始化。首个超管由 `AdminSeedService`（`GOD_ADMIN_EMAIL`）
 * 或运维脚本 `pnpm seed:admin` 创建。
 */
export class AddAdminType1795060000000 implements MigrationInterface {
  name = 'AddAdminType1795060000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "admins" ADD COLUMN "type" character varying(8) NOT NULL DEFAULT 'normal'`,
    )
    await queryRunner.query(`CREATE INDEX "idx_admin_type" ON "admins" ("type")`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_admin_type"`)
    await queryRunner.query(`ALTER TABLE "admins" DROP COLUMN "type"`)
  }
}
