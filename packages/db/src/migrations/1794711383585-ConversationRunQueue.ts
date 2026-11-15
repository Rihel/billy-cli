import type { MigrationInterface, QueryRunner } from 'typeorm'

export class ConversationRunQueue1794711383585 implements MigrationInterface {
  name = 'ConversationRunQueue1794711383585'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "conversation_run_queue" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "conversation_id" character varying(20) NOT NULL, "source" character varying(16) NOT NULL, "priority" smallint NOT NULL, "status" character varying(16) NOT NULL DEFAULT 'queued', "dedupe_key" character varying(80), "payload" jsonb NOT NULL, "run_id" character varying(20), "error" text, "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3), CONSTRAINT "PK_5a438b05fe181cdf3e58deac226" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_queue_dedupe" ON "conversation_run_queue"  ("dedupe_key") WHERE dedupe_key IS NOT NULL`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_run_queue_dispatch" ON "conversation_run_queue"  ("conversation_id", "status", "priority", "created_at") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_run_queue_dispatch"`)
    await queryRunner.query(`DROP INDEX "public"."uk_run_queue_dedupe"`)
    await queryRunner.query(`DROP TABLE "conversation_run_queue"`)
  }
}
