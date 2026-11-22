import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `ai_workspaces.container_runtime` → `driver`，并把取值统一成 host / container / pod。
 *
 * 语义变化：旧列只表达「容器用 docker 还是 k8s」；新列表达「这个工作区用哪个驱动」，
 * 一个字段就能识别：`host`（本机）/ `container`（Docker）/ `pod`（Kubernetes）。
 */
export class AddWorkspaceDriver1795357035915 implements MigrationInterface {
  name = 'AddWorkspaceDriver1795357035915'

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_workspaces" RENAME COLUMN "container_runtime" TO "driver"`,
    )
    await queryRunner.query(
      `UPDATE "ai_workspaces" SET "driver" = 'container' WHERE "driver" = 'docker'`,
    )
    await queryRunner.query(
      `UPDATE "ai_workspaces" SET "driver" = 'pod' WHERE "driver" = 'kubernetes'`,
    )
    await queryRunner.query(
      `UPDATE "ai_workspaces" SET "driver" = 'host' WHERE "backend" = 'local'`,
    )
    await queryRunner.query(
      `UPDATE "ai_workspaces" SET "driver" = 'container' WHERE "driver" IS NULL AND "backend" = 'container'`,
    )
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "ai_workspaces" SET "driver" = 'docker' WHERE "driver" = 'container'`,
    )
    await queryRunner.query(
      `UPDATE "ai_workspaces" SET "driver" = 'kubernetes' WHERE "driver" = 'pod'`,
    )
    await queryRunner.query(`UPDATE "ai_workspaces" SET "driver" = NULL WHERE "driver" = 'host'`)
    await queryRunner.query(
      `ALTER TABLE "ai_workspaces" RENAME COLUMN "driver" TO "container_runtime"`,
    )
  }
}
