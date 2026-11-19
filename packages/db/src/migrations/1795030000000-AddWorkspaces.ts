import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 工作空间（AI 执行环境）表 + 会话/文件归属。
 *
 * 方案 B（`docs/design/workspace.md` §7）：
 * - 本表只存**配置 + 用户意图**（`desired_status`），main 是唯一写方；
 * - 实际运行态由 workspace-service 实时返回，不落库；
 * - 回填：每个存量 admin 一条默认工作区；每个存量会话一条非默认工作区（id 复用会话 id，
 *   local 目录 `{root}/{conversationId}` 不变），`conversations.workspace_id` 指向它。
 */
export class AddWorkspaces1795030000000 implements MigrationInterface {
  name = 'AddWorkspaces1795030000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ai_workspaces" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "owner_type" character varying(8) NOT NULL DEFAULT 'admin', "owner_id" character varying(20) NOT NULL, "name" character varying(64) NOT NULL, "is_default" boolean NOT NULL DEFAULT false, "backend" character varying(16) NOT NULL DEFAULT 'container', "image" character varying(128), "location" jsonb, "file_access" character varying(16) NOT NULL DEFAULT 'write', "desired_status" character varying(16) NOT NULL DEFAULT 'stopped', "last_used_at" TIMESTAMP(3), CONSTRAINT "PK_ai_workspaces" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_workspace_owner" ON "ai_workspaces" ("owner_type", "owner_id")`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_workspace_default" ON "ai_workspaces" ("owner_type", "owner_id") WHERE "is_default" = true AND "deleted_at" IS NULL`,
    )
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD COLUMN "workspace_id" character varying(20)`,
    )
    await queryRunner.query(
      `ALTER TABLE "ai_files" ADD COLUMN "workspace_id" character varying(20)`,
    )
    await queryRunner.query(
      `CREATE INDEX "idx_ai_file_workspace" ON "ai_files" ("workspace_id", "updated_at")`,
    )
    // 存量 admin：一条默认工作区（容器后端，镜像留空，执行面回退到配置默认版本）
    await queryRunner.query(`
      INSERT INTO "ai_workspaces" ("id", "owner_type", "owner_id", "name", "is_default", "backend", "file_access", "desired_status")
      SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 20), 'admin', a."id", '默认工作区', true, 'container', 'write', 'stopped'
      FROM "admins" a
      WHERE a."deleted_at" IS NULL
      ON CONFLICT DO NOTHING
    `)
    // 存量会话：一条非默认工作区，id 复用会话 id（local 目录 `{root}/{conversationId}` 不变）
    await queryRunner.query(`
      INSERT INTO "ai_workspaces" ("id", "owner_type", "owner_id", "name", "is_default", "backend", "location", "file_access", "desired_status")
      SELECT c."id", 'admin', c."user_id", COALESCE(NULLIF(c."title", ''), '会话工作区'), false, 'local',
             jsonb_build_object('root', c."id"),
             CASE WHEN c."file_access" = 'read-only' THEN 'read-only' ELSE 'write' END,
             'stopped'
      FROM "conversations" c
      WHERE c."deleted_at" IS NULL
      ON CONFLICT DO NOTHING
    `)
    await queryRunner.query(
      `UPDATE "conversations" SET "workspace_id" = "id" WHERE "workspace_id" IS NULL`,
    )
    await queryRunner.query(
      `UPDATE "ai_files" SET "workspace_id" = "conversation_id" WHERE "workspace_id" IS NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_ai_file_workspace"`)
    await queryRunner.query(`ALTER TABLE "ai_files" DROP COLUMN "workspace_id"`)
    await queryRunner.query(`ALTER TABLE "conversations" DROP COLUMN "workspace_id"`)
    await queryRunner.query(`DROP INDEX "public"."uk_workspace_default"`)
    await queryRunner.query(`DROP INDEX "public"."idx_workspace_owner"`)
    await queryRunner.query(`DROP TABLE "ai_workspaces"`)
  }
}
