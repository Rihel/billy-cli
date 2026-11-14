import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `ai_connectors.auth_state` / `auth_state_version`：驱动的授权状态快照（如 lark-cli 的 HOME）。
 *
 * 为什么要存库：pod 无状态、不挂 PVC，CLI 的用户 token 在磁盘上，进程一换就丢。
 * 驱动调用前 hydrate 到临时目录、调用后 diff 写回；版本号用于写回 CAS。
 */
export class ConnectorAuthState1794324144802 implements MigrationInterface {
  name = 'ConnectorAuthState1794324144802'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_connectors" ADD "auth_state" jsonb`)
    await queryRunner.query(
      `ALTER TABLE "ai_connectors" ADD "auth_state_version" integer NOT NULL DEFAULT '0'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_connectors" DROP COLUMN "auth_state_version"`)
    await queryRunner.query(`ALTER TABLE "ai_connectors" DROP COLUMN "auth_state"`)
  }
}
