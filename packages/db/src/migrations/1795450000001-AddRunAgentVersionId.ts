import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `runs.agent_version_id`：S2 Agent 版本物化的接入点。
 *
 * S1 只加字段（nullable、不回填）：旧 run 没有版本概念，读路径必须继续兼容 null。
 */
export class AddRunAgentVersionId1795450000001 implements MigrationInterface {
  name = 'AddRunAgentVersionId1795450000001'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" ADD "agent_version_id" character varying(32)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "agent_version_id"`)
  }
}
