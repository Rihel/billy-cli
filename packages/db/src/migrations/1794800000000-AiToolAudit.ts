import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 工具审计表（capability-gateway 唯一写方）。
 *
 * 只记“谁在什么轮次调了什么工具、结果如何、多久”，入参/出参全文仍以 timeline 为准；
 * 不建物理外键（工程硬规则）。
 */
export class AiToolAudit1794800000000 implements MigrationInterface {
  name = 'AiToolAudit1794800000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "ai_tool_audit" (
        "id" varchar(36) PRIMARY KEY,
        "request_id" varchar(128) NOT NULL,
        "run_id" varchar(32) NOT NULL,
        "conversation_id" varchar(32) NOT NULL,
        "user_id" varchar(32),
        "tool_key" varchar(128) NOT NULL,
        "tool_call_id" varchar(128),
        "worker_id" varchar(128) NOT NULL,
        "status" varchar(16) NOT NULL,
        "reason" varchar(128),
        "duration_ms" int NOT NULL DEFAULT 0,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ai_tool_audit_run" ON "ai_tool_audit" ("run_id", "created_at")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ai_tool_audit_conversation" ON "ai_tool_audit" ("conversation_id", "created_at")`,
    )
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_ai_tool_audit_tool" ON "ai_tool_audit" ("tool_key", "created_at")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_tool_audit"`)
  }
}
