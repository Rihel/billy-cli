import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 把「从空库跑迁移」的结果对齐到实体（2026-11-14 迁移审计发现）。
 *
 * 背景：开发库上这两处曾经是**手工/同步**改过的，迁移链里没有对应记录 ——
 * 于是 `docker compose` 全新卷跑完 27 条迁移后，`schema:log` 仍会要求：
 *
 * 1. `users.status`（实体有 `@Column`，迁移没建）；
 * 2. 邮箱唯一约束：初始迁移建的是 `UQ_97672... UNIQUE (email)`，
 *    实体要的是 `uk_user_email UNIQUE (email, deleted_at)`（软删感知）。
 *
 * 写法刻意**全幂等**：开发库已经是对的（status 在、uk 在、旧 UQ 不在），
 * 生产库可能三种状态都有；用 IF EXISTS / 查询 pg_constraint 兜住，重复执行不报错。
 */
export class SyncUserSchema1794627140858 implements MigrationInterface {
  name = 'SyncUserSchema1794627140858'

  public async up(queryRunner: QueryRunner): Promise<void> {
    const status = (await queryRunner.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'status'`,
    )) as unknown[]
    if (status.length === 0) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD "status" character varying(20) NOT NULL DEFAULT 'enabled'`,
      )
      await queryRunner.query(`COMMENT ON COLUMN "users"."status" IS '用户状态'`)
    }

    // 旧的单列唯一（email）与软删语义冲突：删掉后用 (email, deleted_at) 取代
    await queryRunner.query(
      `ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_97672ac88f789774dd47f7c8be3"`,
    )
    const uk = (await queryRunner.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'uk_user_email' AND conrelid = 'users'::regclass`,
    )) as unknown[]
    if (uk.length === 0) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD CONSTRAINT "uk_user_email" UNIQUE ("email", "deleted_at")`,
      )
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "uk_user_email"`)
    const old = (await queryRunner.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'UQ_97672ac88f789774dd47f7c8be3' AND conrelid = 'users'::regclass`,
    )) as unknown[]
    if (old.length === 0) {
      await queryRunner.query(
        `ALTER TABLE "users" ADD CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email")`,
      )
    }
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "status"`)
  }
}
