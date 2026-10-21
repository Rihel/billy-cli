import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `runs.status` 新增 `suspended`（等用户回答工具提问）。
 *
 * 为什么把它算进「会话活跃」的唯一索引：挂起期间用户可能刷新 / 走开，但这一轮并没有结束；
 * 如果允许同会话再开一条根 run，恢复时会同时存在两条活着的上下文，取消 / 恢复 / 统计都会分叉。
 * 用户要放弃这一轮时，走停止（canceled）再开新的一轮，而不是静默并存。
 */
export class AddRunSuspendedStatus1791800000000 implements MigrationInterface {
  name = 'AddRunSuspendedStatus1791800000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_run_active_conversation"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_active_conversation" ON "runs" ("conversation_id") ` +
        `WHERE parent_run_id IS NULL AND status IN ('pending','running','suspended')`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uk_run_active_conversation"`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_active_conversation" ON "runs" ("conversation_id") ` +
        `WHERE parent_run_id IS NULL AND status IN ('pending','running')`,
    )
  }
}
