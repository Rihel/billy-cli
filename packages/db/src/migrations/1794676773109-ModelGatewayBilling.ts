import type { MigrationInterface, QueryRunner } from 'typeorm'

export class ModelGatewayBilling1794676773109 implements MigrationInterface {
  name = 'ModelGatewayBilling1794676773109'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_provider_keys" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "created_by" character varying(64), "updated_by" character varying(64), "deleted_by" character varying(64), "provider_id" character varying(20) NOT NULL, "label" character varying(64) NOT NULL, "secret" text NOT NULL, "status" character varying(8) NOT NULL DEFAULT 'active', "weight" integer NOT NULL DEFAULT '1', "rpm" integer, "tpm" integer, "daily_tokens" bigint, "daily_cost_micros" bigint, "last_used_at" TIMESTAMP(3), "failure_count" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_69bf5ae5c33211f10d27b45a214" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_provider_key_status" ON "ai_provider_keys"  ("status") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_provider_key_provider" ON "ai_provider_keys"  ("provider_id") `,
    )
    await queryRunner.query(
      `CREATE TABLE "model_gateway_usage" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "request_id" character varying(32) NOT NULL, "attempt" integer NOT NULL DEFAULT '1', "run_id" character varying(20), "conversation_id" character varying(20), "identity_type" character varying(8), "identity_id" character varying(20), "provider_id" character varying(20), "model_id" character varying(20), "key_id" character varying(20), "stream" boolean NOT NULL DEFAULT false, "status" character varying(8) NOT NULL, "http_status" integer, "error_code" integer, "unit_type" character varying(8) NOT NULL DEFAULT 'token', "input_tokens" bigint, "output_tokens" bigint, "cache_read_tokens" bigint, "cache_write_tokens" bigint, "reasoning_tokens" bigint, "units" numeric(12,4), "cost_micros" bigint, "price_snapshot" jsonb, "ttft_ms" integer, "duration_ms" integer, "usage_missing" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_b01ac9e5620bd2618b27a23c0f1" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_gateway_usage_request" ON "model_gateway_usage"  ("request_id") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_gateway_usage_model" ON "model_gateway_usage"  ("model_id") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_gateway_usage_run" ON "model_gateway_usage"  ("run_id") `,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_gateway_usage_created_at" ON "model_gateway_usage"  ("created_at") `,
    )
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "input_price_per_1m" numeric(12,4)`)
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "output_price_per_1m" numeric(12,4)`)
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "cache_read_price_per_1m" numeric(12,4)`)
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "cache_write_price_per_1m" numeric(12,4)`)
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "price_per_image" numeric(12,4)`)
    await queryRunner.query(`ALTER TABLE "ai_models" ADD "price_per_second" numeric(12,4)`)
    await queryRunner.query(
      `ALTER TABLE "ai_models" ADD "currency" character varying(3) NOT NULL DEFAULT 'CNY'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "currency"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "price_per_second"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "price_per_image"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "cache_write_price_per_1m"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "cache_read_price_per_1m"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "output_price_per_1m"`)
    await queryRunner.query(`ALTER TABLE "ai_models" DROP COLUMN "input_price_per_1m"`)
    await queryRunner.query(`DROP INDEX "public"."idx_gateway_usage_created_at"`)
    await queryRunner.query(`DROP INDEX "public"."idx_gateway_usage_run"`)
    await queryRunner.query(`DROP INDEX "public"."idx_gateway_usage_model"`)
    await queryRunner.query(`DROP INDEX "public"."idx_gateway_usage_request"`)
    await queryRunner.query(`DROP TABLE "model_gateway_usage"`)
    await queryRunner.query(`DROP INDEX "public"."idx_provider_key_provider"`)
    await queryRunner.query(`DROP INDEX "public"."idx_provider_key_status"`)
    await queryRunner.query(`DROP TABLE "ai_provider_keys"`)
  }
}
