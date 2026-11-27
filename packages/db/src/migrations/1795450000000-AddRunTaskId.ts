import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddRunTaskId1795450000000 implements MigrationInterface {
  name = 'AddRunTaskId1795450000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" ADD "task_id" character varying(32)`)
    await queryRunner.query(
      `CREATE INDEX "idx_run_task" ON "runs" ("conversation_id", "task_id", "created_at")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_run_task"`)
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "task_id"`)
  }
}
