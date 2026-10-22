import type { MigrationInterface, QueryRunner } from "typeorm";

export class MonitorEngine1792595910578 implements MigrationInterface {
    name = 'MonitorEngine1792595910578'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "monitor_alerts" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "rule_key" character varying(100) NOT NULL, "kind" character varying(8) NOT NULL DEFAULT 'metric', "rule_name" character varying(100) NOT NULL, "level" character varying(10) NOT NULL, "subject_id" character varying(128) NOT NULL, "instance_id" character varying(64) NOT NULL DEFAULT '', "status" character varying(12) NOT NULL DEFAULT 'firing', "first_fired_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_fired_at" TIMESTAMP WITH TIME ZONE NOT NULL, "recovered_at" TIMESTAMP WITH TIME ZONE, "duration_ms" bigint, "miss_count" integer NOT NULL DEFAULT '0', "value" numeric(20,4), "threshold" numeric(20,4), "window_key" character varying(64), "first_snapshot" jsonb, "last_snapshot" jsonb, CONSTRAINT "PK_b0678f298a6be251ec121ff03b7" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_monitor_alert_rule" ON "monitor_alerts"  ("rule_key", "first_fired_at") `);
        await queryRunner.query(`CREATE INDEX "idx_monitor_alert_list" ON "monitor_alerts"  ("status", "level", "first_fired_at") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "uk_monitor_alert_open" ON "monitor_alerts"  ("rule_key", "subject_id") WHERE "status" = 'firing'`);
        await queryRunner.query(`CREATE TABLE "monitor_metric_samples" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "metric_kind" character varying(8) NOT NULL, "metric_key" character varying(100) NOT NULL, "window_key" character varying(64) NOT NULL, "window_start" TIMESTAMP WITH TIME ZONE NOT NULL, "window_end" TIMESTAMP WITH TIME ZONE NOT NULL, "instance_id" character varying(64) NOT NULL DEFAULT '', "dimension_type" character varying(16) NOT NULL DEFAULT 'total', "dimension_key" character varying(128) NOT NULL DEFAULT '', "value" numeric(20,4) NOT NULL, "labels" jsonb, CONSTRAINT "uk_monitor_sample_window" UNIQUE ("metric_key", "window_key", "instance_id", "dimension_type", "dimension_key"), CONSTRAINT "PK_2da3b5be58d6867797e11cad677" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_monitor_sample_dimension" ON "monitor_metric_samples"  ("dimension_type", "dimension_key", "window_end") `);
        await queryRunner.query(`CREATE INDEX "idx_monitor_sample_metric" ON "monitor_metric_samples"  ("metric_key", "window_end") `);
        await queryRunner.query(`CREATE TABLE "monitor_rules" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "rule_key" character varying(100) NOT NULL, "name" character varying(100) NOT NULL, "description" character varying(500) NOT NULL, "category" character varying(16) NOT NULL, "kind" character varying(8) NOT NULL, "driver" character varying(8) NOT NULL DEFAULT 'batch', "metric_key" character varying(100), "evaluation_interval_seconds" integer NOT NULL, "window_seconds" integer NOT NULL, "source" character varying(16) NOT NULL DEFAULT 'code', "config" jsonb NOT NULL, "definition_version" character varying(64), "enabled" boolean NOT NULL DEFAULT true, "deprecated" boolean NOT NULL DEFAULT false, CONSTRAINT "uk_monitor_rule_key" UNIQUE ("rule_key"), CONSTRAINT "PK_71ee290d8a8c26739d0a0be0d78" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_monitor_rule_category" ON "monitor_rules"  ("category", "enabled") `);
        await queryRunner.query(`ALTER TABLE "alert_logs" ADD "alert_id" character varying(20)`);
        await queryRunner.query(`ALTER TABLE "alert_logs" ALTER COLUMN "rule_name" TYPE character varying(100)`);
        await queryRunner.query(`CREATE INDEX "idx_alert_log_alert_id" ON "alert_logs"  ("alert_id", "sent_at") `);
        // 旧手工规则表已无代码引用，且当前部署没有数据；直接删表，避免留下两套规则表
        await queryRunner.query(`DROP TABLE IF EXISTS "alert_rules"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_alert_log_alert_id"`);
        await queryRunner.query(`ALTER TABLE "alert_logs" ALTER COLUMN "rule_name" TYPE character varying(50)`);
        await queryRunner.query(`ALTER TABLE "alert_logs" DROP COLUMN "alert_id"`);
        await queryRunner.query(`DROP INDEX "public"."idx_monitor_rule_category"`);
        await queryRunner.query(`DROP TABLE "monitor_rules"`);
        await queryRunner.query(`DROP INDEX "public"."idx_monitor_sample_metric"`);
        await queryRunner.query(`DROP INDEX "public"."idx_monitor_sample_dimension"`);
        await queryRunner.query(`DROP TABLE "monitor_metric_samples"`);
        await queryRunner.query(`DROP INDEX "public"."uk_monitor_alert_open"`);
        await queryRunner.query(`DROP INDEX "public"."idx_monitor_alert_list"`);
        await queryRunner.query(`DROP INDEX "public"."idx_monitor_alert_rule"`);
        await queryRunner.query(`DROP TABLE "monitor_alerts"`);
    }

}
