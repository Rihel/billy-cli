import type { MigrationInterface, QueryRunner } from "typeorm";

/** alert_rules 扩展：事件规则阈值 + metric / surge 指标规则字段（幂等 IF NOT EXISTS）。 */
export class AlertRuleMetricFields1788193354014 implements MigrationInterface {
    name = 'AlertRuleMetricFields1788193354014'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "threshold" integer NOT NULL DEFAULT '1'`);
        await queryRunner.query(`ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "threshold_window_seconds" integer NOT NULL DEFAULT '60'`);
        await queryRunner.query(`ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "metric" character varying(100)`);
        await queryRunner.query(`ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "operator" character varying(10)`);
        await queryRunner.query(`ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "threshold_value" double precision`);
        await queryRunner.query(`ALTER TABLE "alert_rules" ADD COLUMN IF NOT EXISTS "period_seconds" integer NOT NULL DEFAULT '60'`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "period_seconds"`);
        await queryRunner.query(`ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "threshold_value"`);
        await queryRunner.query(`ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "operator"`);
        await queryRunner.query(`ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "metric"`);
        await queryRunner.query(`ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "threshold_window_seconds"`);
        await queryRunner.query(`ALTER TABLE "alert_rules" DROP COLUMN IF EXISTS "threshold"`);
    }
}
