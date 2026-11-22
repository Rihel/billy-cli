import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddToolEffects1795331980277 implements MigrationInterface {
  name = 'AddToolEffects1795331980277'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_tool_effects" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "run_id" character varying(32) NOT NULL, "conversation_id" character varying(32) NOT NULL, "tool_call_id" character varying(128) NOT NULL, "capability" character varying(64) NOT NULL, "request_hash" character varying(32) NOT NULL, "status" character varying(16) NOT NULL, "attempts" integer NOT NULL DEFAULT 1, "deadline_at" TIMESTAMP(3) NOT NULL, "outcome" jsonb, "result_bytes" integer NOT NULL DEFAULT 0, "settled_at" TIMESTAMP(3), CONSTRAINT "PK_5f43a0f2d0b38f3cb1d5a6c8c1f" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_ai_tool_effect_run_call" ON "ai_tool_effects"  ("run_id", "tool_call_id") WHERE deleted_at IS NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_ai_tool_effect_run" ON "ai_tool_effects"  ("run_id", "created_at") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_ai_tool_effect_capability" ON "ai_tool_effects"  ("capability", "created_at") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_ai_tool_effect_capability"`)
    await queryRunner.query(`DROP INDEX "public"."idx_ai_tool_effect_run"`)
    await queryRunner.query(`DROP INDEX "public"."uk_ai_tool_effect_run_call"`)
    await queryRunner.query(`DROP TABLE "ai_tool_effects"`)
  }
}
