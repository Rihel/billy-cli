import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 子 agent → 子会话。
 *
 * `conversations` 增加父子/根/深度/来源字段；已有会话全部是根会话，回填 `root_conversation_id = id`。
 * 唯一索引 `uk_conversation_origin` 保证「同一个父 run 的同一个工具调用只建一次子会话」，
 * 与 `runs.uk_run_tool_call` 一起构成幂等。
 */
export class ConversationSubagent1794700000000 implements MigrationInterface {
  name = 'ConversationSubagent1794700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "parent_conversation_id" varchar(20)`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "root_conversation_id" varchar(20)`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "kind" varchar(16) NOT NULL DEFAULT 'root'`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "depth" int NOT NULL DEFAULT 0`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "origin_run_id" varchar(20)`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "origin_tool_call_id" varchar(64)`,
    )
    await queryRunner.query(
      `UPDATE "conversations" SET "root_conversation_id" = "id" WHERE "root_conversation_id" IS NULL AND "parent_conversation_id" IS NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_conversation_parent_created" ON "conversations" ("parent_conversation_id", "created_at")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uk_conversation_origin" ON "conversations" ("origin_run_id", "origin_tool_call_id") WHERE "kind" = 'subagent' AND "origin_run_id" IS NOT NULL AND "origin_tool_call_id" IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "uk_conversation_origin"`)
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_conversation_parent_created"`)
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "origin_tool_call_id"`,
    )
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "origin_run_id"`)
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "depth"`)
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN IF EXISTS "kind"`)
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "root_conversation_id"`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN IF EXISTS "parent_conversation_id"`,
    )
  }
}
