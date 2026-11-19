import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 修复 `AddWorkspaces` 的迁移口径：它给**每个会话**建了一个工作区（id 复用会话 id），
 * 导致侧栏里「一个会话一个文件夹」。
 *
 * 正确口径（`docs/design/workspace.md`）：**工作区是文件夹，会话挂在文件夹下**。
 * 本迁移把按会话建出来的工作区收回：
 * 1. 这些会话的 `workspace_id` 改回 owner 的默认工作区；
 * 2. 按会话建的工作区软删（`location.root` 等于自身 id 是它们唯一的特征）。
 *
 * 用户自己建的工作区（`location` 为 null / 非 root=id）不动。
 */
export class FixConversationWorkspaces1795040000000 implements MigrationInterface {
  name = 'FixConversationWorkspaces1795040000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "conversations" c
      SET "workspace_id" = (
        SELECT w."id" FROM "ai_workspaces" w
        WHERE w."owner_type" = 'admin'
          AND w."owner_id" = c."user_id"
          AND w."is_default" = true
          AND w."deleted_at" IS NULL
        LIMIT 1
      )
      WHERE c."workspace_id" IN (
        SELECT w."id" FROM "ai_workspaces" w
        WHERE w."is_default" = false
          AND w."deleted_at" IS NULL
          AND w."location"->>'root' = w."id"
      )
    `)
    await queryRunner.query(`
      UPDATE "ai_workspaces"
      SET "deleted_at" = now()
      WHERE "is_default" = false
        AND "deleted_at" IS NULL
        AND "location"->>'root' = "id"
    `)
    // 清掉指向已不存在 / 已软删工作区的孤儿引用（UI 上会落到「未分组」）
    await queryRunner.query(`
      UPDATE "conversations" c
      SET "workspace_id" = NULL
      WHERE c."workspace_id" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ai_workspaces" w
          WHERE w."id" = c."workspace_id" AND w."deleted_at" IS NULL
        )
    `)
  }

  public async down(): Promise<void> {
    // 数据修复不可逆：会话已归到默认工作区，原「按会话建」的工作区没有保留价值
  }
}
