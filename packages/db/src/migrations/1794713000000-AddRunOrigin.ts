import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `runs.origin`：区分「用户发起」与「子 agent 完成唤醒」的根 run。
 *
 * 已定方案见 `docs/design/async-subagent.md` §3.2：
 * 唤醒 run 仍是 `parent_run_id IS NULL` 的 root run，只把 `origin` 标成 `subagent`，
 * UI / 审计据此区分两种发起来源；历史数据一律回填 `user`（默认值即回填）。
 */
export class AddRunOrigin1794713000000 implements MigrationInterface {
  name = 'AddRunOrigin1794713000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "runs" ADD "origin" character varying(16) NOT NULL DEFAULT 'user'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "origin"`)
  }
}
