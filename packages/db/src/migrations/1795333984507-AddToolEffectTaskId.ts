import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddToolEffectTaskId1795333984507 implements MigrationInterface {
  name = 'AddToolEffectTaskId1795333984507'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_tool_effects" ADD "task_id" character varying(128)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_tool_effects" DROP COLUMN "task_id"`)
  }
}
