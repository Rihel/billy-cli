import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddToolEffectAttempts1795338900853 implements MigrationInterface {
  name = 'AddToolEffectAttempts1795338900853'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_tool_effect_attempts" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "effect_id" character varying(20) NOT NULL, "run_id" character varying(32) NOT NULL, "tool_call_id" character varying(128) NOT NULL, "capability" character varying(64) NOT NULL, "generation" integer NOT NULL, "status" character varying(16) NOT NULL, "deadline_at" TIMESTAMP(3) NOT NULL, "dispatched_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "outcome" jsonb, "result_bytes" integer NOT NULL DEFAULT 0, "task_id" character varying(128), "settled_at" TIMESTAMP(3), CONSTRAINT "PK_9d1c7e2f0c8b4a5d6e7f8a9b0c1" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_ai_tool_effect_attempt_gen" ON "ai_tool_effect_attempts"  ("effect_id", "generation") WHERE deleted_at IS NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_ai_tool_effect_attempt_run" ON "ai_tool_effect_attempts"  ("run_id", "updated_at") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_ai_tool_effect_attempt_run"`)
    await queryRunner.query(`DROP INDEX "public"."uk_ai_tool_effect_attempt_gen"`)
    await queryRunner.query(`DROP TABLE "ai_tool_effect_attempts"`)
  }
}
