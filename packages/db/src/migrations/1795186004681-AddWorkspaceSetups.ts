import type { MigrationInterface, QueryRunner } from 'typeorm'

export class AddWorkspaceSetups1795186004681 implements MigrationInterface {
  name = 'AddWorkspaceSetups1795186004681'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_workspace_setups" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "owner_type" character varying(8) NOT NULL, "owner_id" character varying(20) NOT NULL, "name" character varying(64) NOT NULL, "packages" jsonb NOT NULL DEFAULT '[]', "files" jsonb NOT NULL DEFAULT '[]', "env" jsonb NOT NULL DEFAULT '{}', "status" character varying(16) NOT NULL DEFAULT 'active', CONSTRAINT "PK_57ef1c1a13cef75dbe7536748bd" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_workspace_setup_owner" ON "ai_workspace_setups"  ("owner_type", "owner_id") `,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_workspace_setup_name" ON "ai_workspace_setups"  ("owner_type", "owner_id", "name") WHERE deleted_at IS NULL`,
    )
    await queryRunner.query(`ALTER TABLE "ai_workspaces" ADD "setup_id" character varying(20)`)
    await queryRunner.query(
      `ALTER TABLE "ai_workspaces" ADD "setup_extra" jsonb NOT NULL DEFAULT '[]'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_workspaces" DROP COLUMN "setup_extra"`)
    await queryRunner.query(`ALTER TABLE "ai_workspaces" DROP COLUMN "setup_id"`)
    await queryRunner.query(`DROP INDEX "public"."uk_workspace_setup_name"`)
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_setup_owner"`)
    await queryRunner.query(`DROP TABLE "ai_workspace_setups"`)
  }
}
