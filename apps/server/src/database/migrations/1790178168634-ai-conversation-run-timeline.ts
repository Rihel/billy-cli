import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AiConversationRunTimeline1790178168634 implements MigrationInterface {
  name = 'AiConversationRunTimeline1790178168634'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "conversations" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "user_id" character varying(20) NOT NULL, "agent_key" character varying(64) NOT NULL, "title" text NOT NULL DEFAULT '', "status" character varying(20) NOT NULL DEFAULT 'active', "last_active_at" TIMESTAMP(3) NOT NULL, "turn_count" integer NOT NULL DEFAULT '0', "total_tokens" bigint NOT NULL DEFAULT '0', "metadata" jsonb, CONSTRAINT "PK_ee34f4f7ced4ec8681f26bf04ef" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_conversation_user_active" ON "conversations"  ("user_id", "last_active_at") `,
    )
    await queryRunner.query(
      `CREATE TABLE "runs" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "conversation_id" character varying(20) NOT NULL, "agent_key" character varying(64) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'pending', "engine_run_id" character varying(64), "triggered_by" character varying(20), "request_id" character varying(64), "request_snapshot" jsonb, "active_stream_id" character varying(64), "snapshot" jsonb, "error_code" character varying(32), "error_stage" character varying(20), "error_message" text, "error_detail" jsonb, "recovery_count" integer NOT NULL DEFAULT '0', "usage" jsonb, "step_count" integer NOT NULL DEFAULT '0', "tool_call_count" integer NOT NULL DEFAULT '0', "duration_ms" integer, "first_token_ms" integer, "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3), "heartbeat_at" TIMESTAMP(3), CONSTRAINT "PK_46d6a1e257c38ba58f1a3c30836" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_active_conversation" ON "runs"  ("conversation_id") WHERE status IN ('pending','running')`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_engine_run_id" ON "runs"  ("engine_run_id") `,
    )
    await queryRunner.query(`CREATE INDEX "idx_run_status" ON "runs"  ("status") `)
    await queryRunner.query(
      `CREATE INDEX "idx_run_conversation_created" ON "runs"  ("conversation_id", "created_at") `,
    )
    await queryRunner.query(
      `CREATE TABLE "timelines" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "conversation_id" character varying(20) NOT NULL, "run_id" character varying(20), "message_id" character varying(64) NOT NULL DEFAULT '', "seq" integer NOT NULL, "attempt" integer NOT NULL DEFAULT '1', "role" character varying(20) NOT NULL, "kind" character varying(32) NOT NULL, "state" character varying(20), "tool_key" character varying(64), "tool_call_id" character varying(64), "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3), "duration_ms" integer, "usage" jsonb, "payload" jsonb, CONSTRAINT "PK_b7e242fccf271037f4d6a00d9dd" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_timeline_summary" ON "timelines"  ("conversation_id", "seq") WHERE kind = 'summary'`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_timeline_tool_call" ON "timelines"  ("run_id", "tool_call_id", "kind") WHERE tool_call_id IS NOT NULL`,
    )
    await queryRunner.query(`CREATE INDEX "idx_timeline_tool" ON "timelines"  ("tool_key") `)
    await queryRunner.query(`CREATE INDEX "idx_timeline_message" ON "timelines"  ("message_id") `)
    await queryRunner.query(
      `CREATE INDEX "idx_timeline_run_seq" ON "timelines"  ("run_id", "seq") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_timeline_conversation_seq" ON "timelines"  ("conversation_id", "seq") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_timeline_conversation_seq"`)
    await queryRunner.query(`DROP INDEX "public"."idx_timeline_run_seq"`)
    await queryRunner.query(`DROP INDEX "public"."idx_timeline_message"`)
    await queryRunner.query(`DROP INDEX "public"."idx_timeline_tool"`)
    await queryRunner.query(`DROP INDEX "public"."uk_timeline_tool_call"`)
    await queryRunner.query(`DROP INDEX "public"."idx_timeline_summary"`)
    await queryRunner.query(`DROP TABLE "timelines"`)
    await queryRunner.query(`DROP INDEX "public"."idx_run_conversation_created"`)
    await queryRunner.query(`DROP INDEX "public"."idx_run_status"`)
    await queryRunner.query(`DROP INDEX "public"."uk_run_engine_run_id"`)
    await queryRunner.query(`DROP INDEX "public"."uk_run_active_conversation"`)
    await queryRunner.query(`DROP TABLE "runs"`)
    await queryRunner.query(`DROP INDEX "public"."idx_conversation_user_active"`)
    await queryRunner.query(`DROP TABLE "conversations"`)
  }
}
