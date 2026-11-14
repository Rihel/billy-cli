import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 会话级文件权限（只读 / 可写）。
 *
 * 只影响沙箱内的写权限；"要不要沙箱"是部署配置，不是会话字段（web 产品的安全底线）。
 */
export class ConversationFileAccess1794510000000 implements MigrationInterface {
  name = 'ConversationFileAccess1794510000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "file_access" character varying(16) NOT NULL DEFAULT 'workspace-write'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "file_access"`)
  }
}
