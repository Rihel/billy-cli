import type { MigrationInterface, QueryRunner } from 'typeorm'

export class MonitorAlertRuleLog1788190985534 implements MigrationInterface {
  name = 'MonitorAlertRuleLog1788190985534'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "alert_logs" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "rule_id" character varying, "rule_name" character varying(50) NOT NULL, "title" text NOT NULL, "message" text NOT NULL, "channel" character varying(20) NOT NULL, "status" character varying(10) NOT NULL, "error" text, "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_839d59dc0124b583ee4233a7df9" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_alert_log_rule_id" ON "alert_logs"  ("rule_id") `)
    await queryRunner.query(`CREATE INDEX "idx_alert_log_sent_at" ON "alert_logs"  ("sent_at") `)
    await queryRunner.query(
      `CREATE TABLE "alert_rules" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "name" character varying(50) NOT NULL, "type" character varying(20) NOT NULL, "match_codes" jsonb NOT NULL, "keywords" text NOT NULL, "level" character varying(10) NOT NULL DEFAULT 'error', "channels" text NOT NULL, "throttle_seconds" integer NOT NULL DEFAULT '60', "enabled" boolean NOT NULL DEFAULT true, CONSTRAINT "uk_alert_rule_name" UNIQUE ("name", "deleted_at"), CONSTRAINT "PK_ae580564f087ffab9d229225aec" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_alert_rule_type" ON "alert_rules"  ("type") `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_alert_rule_type"`)
    await queryRunner.query(`DROP TABLE "alert_rules"`)
    await queryRunner.query(`DROP INDEX "public"."idx_alert_log_sent_at"`)
    await queryRunner.query(`DROP INDEX "public"."idx_alert_log_rule_id"`)
    await queryRunner.query(`DROP TABLE "alert_logs"`)
  }
}
