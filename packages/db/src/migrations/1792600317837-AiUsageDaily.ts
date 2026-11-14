import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AiUsageDaily1792600317837 implements MigrationInterface {
  name = 'AiUsageDaily1792600317837'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_usage_daily_dimension" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "stat_date" date NOT NULL, "dimension_type" character varying(16) NOT NULL, "dimension_key" character varying(128) NOT NULL, "conversations" integer NOT NULL DEFAULT '0', "runs" integer NOT NULL DEFAULT '0', "succeeded" integer NOT NULL DEFAULT '0', "failed" integer NOT NULL DEFAULT '0', "total_tokens" bigint NOT NULL DEFAULT '0', "input_tokens" bigint NOT NULL DEFAULT '0', "output_tokens" bigint NOT NULL DEFAULT '0', "calls" integer NOT NULL DEFAULT '0', "tool_succeeded" integer NOT NULL DEFAULT '0', "tool_failed" integer NOT NULL DEFAULT '0', "tool_denied" integer NOT NULL DEFAULT '0', "tool_invalid" integer NOT NULL DEFAULT '0', "tool_unknown" integer NOT NULL DEFAULT '0', "tool_no_result" integer NOT NULL DEFAULT '0', "duration_ms" bigint NOT NULL DEFAULT '0', "metadata" jsonb, CONSTRAINT "uk_ai_usage_dimension" UNIQUE ("stat_date", "dimension_type", "dimension_key"), CONSTRAINT "PK_c7779b208a98aee2724d76da203" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE TABLE "ai_usage_daily" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "stat_date" date NOT NULL, "conversations" integer NOT NULL DEFAULT '0', "new_conversations" integer NOT NULL DEFAULT '0', "active_users" integer NOT NULL DEFAULT '0', "runs" integer NOT NULL DEFAULT '0', "succeeded" integer NOT NULL DEFAULT '0', "failed" integer NOT NULL DEFAULT '0', "canceled" integer NOT NULL DEFAULT '0', "interrupted" integer NOT NULL DEFAULT '0', "total_tokens" bigint NOT NULL DEFAULT '0', "input_tokens" bigint NOT NULL DEFAULT '0', "output_tokens" bigint NOT NULL DEFAULT '0', "cache_read_tokens" bigint NOT NULL DEFAULT '0', "cache_write_tokens" bigint NOT NULL DEFAULT '0', "reasoning_tokens" bigint NOT NULL DEFAULT '0', "steps" integer NOT NULL DEFAULT '0', "tool_calls" integer NOT NULL DEFAULT '0', "tool_succeeded" integer NOT NULL DEFAULT '0', "tool_failed" integer NOT NULL DEFAULT '0', "tool_denied" integer NOT NULL DEFAULT '0', "tool_invalid" integer NOT NULL DEFAULT '0', "tool_unknown" integer NOT NULL DEFAULT '0', "tool_no_result" integer NOT NULL DEFAULT '0', "run_duration_ms" bigint NOT NULL DEFAULT '0', "first_token_ms_sum" bigint NOT NULL DEFAULT '0', "first_token_runs" integer NOT NULL DEFAULT '0', "usage_missing_runs" integer NOT NULL DEFAULT '0', "metadata" jsonb, CONSTRAINT "uk_ai_usage_daily_date" UNIQUE ("stat_date"), CONSTRAINT "PK_eafefb5112271a1906950f3ff9a" PRIMARY KEY ("id"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_usage_daily"`)
    await queryRunner.query(`DROP TABLE "ai_usage_daily_dimension"`)
  }
}
