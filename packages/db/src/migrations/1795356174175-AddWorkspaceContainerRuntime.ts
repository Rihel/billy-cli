import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddWorkspaceContainerRuntime1795356174175 implements MigrationInterface {
  name = 'AddWorkspaceContainerRuntime1795356174175'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_workspaces" ADD "container_runtime" character varying(16)`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_workspaces" DROP COLUMN "container_runtime"`)
  }
}
