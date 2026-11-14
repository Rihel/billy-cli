import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 移除示例模块「任务管理」：`todos` 表与前端页面、SDK、共享 schema 一并下线。
 *
 * 初始迁移仍保留建表历史（TypeORM 的迁移是追加式的，不回改已执行过的文件）；
 * 这里补一条删除，保证已经跑过初始迁移的库也不会留下死表。
 */
export class DropTodo1791900000000 implements MigrationInterface {
  name = 'DropTodo1791900000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "todos"`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "todos" ("id" character varying(20) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "updated_at" TIMESTAMP(3) NOT NULL DEFAULT now(), "deleted_at" TIMESTAMP(3), "title" text NOT NULL, "description" text, "completed" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_ca8cafd59ca6faaf67995344225" PRIMARY KEY ("id"))`,
    )
    await queryRunner.query(`CREATE INDEX "idx_update_at_id" ON "todos" ("updated_at", "id")`)
  }
}
