import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 会话列表改为**按创建时间**排序（`created_at DESC`）。
 *
 * 用户口径：列表要稳定地按"会话是什么时候开的"排，不能因为某个旧会话刚聊过就把它顶到最前
 * （原来的 `last_active_at` 排序还会让分页在翻页途中错位 —— 排序键在变）。
 *
 * 索引跟着换：`(user_id, created_at)` 服务新的排序；`(user_id, last_active_at)` 已无查询使用，
 * 一并删掉（`last_active_at` 列保留：记录最后活动时间，运维排查用）。
 */
export class ConversationListByCreated1794629391251 implements MigrationInterface {
  name = 'ConversationListByCreated1794629391251'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_conversation_user_active"`)
    await queryRunner.query(
      `CREATE INDEX "idx_conversation_user_created" ON "conversations" ("user_id", "created_at")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_conversation_user_created"`)
    await queryRunner.query(
      `CREATE INDEX "idx_conversation_user_active" ON "conversations" ("user_id", "last_active_at")`,
    )
  }
}
