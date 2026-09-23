import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * 子 agent（动态创建）所需的父子列与索引调整。
 *
 * 三件事：
 * 1. `runs` 增加 `parent_run_id` / `depth` / `tool_call_id`（子 run 的归属、深度、幂等键）；
 * 2. **换掉并发保护的部分唯一索引**：`uk_run_active_conversation` 加上 `parent_run_id IS NULL`
 *    —— 子 run 与父 run 同时 running 是正常状态，不加这一条子 agent 一跑就撞唯一键；
 * 3. 新增 `idx_run_parent`（按父查子）与 `uk_run_tool_call`（同一父工具调用只允许一个子 run，幂等去重）。
 *
 * ⚠️ 索引条件的变更（本文件第 2 件事）**TypeORM 的 schema diff 检测不到**，
 * 因此是手工补写的 —— 以后改动价索引（partial unique）后务必回来看这里别漏。
 */
export class RunSubagentParent1790180224656 implements MigrationInterface {
  name = 'RunSubagentParent1790180224656'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "runs" ADD "parent_run_id" character varying(20)`);
    await queryRunner.query(`ALTER TABLE "runs" ADD "depth" integer NOT NULL DEFAULT '0'`);
    await queryRunner.query(`ALTER TABLE "runs" ADD "tool_call_id" character varying(64)`);
    // 并发保护的判据变了：只有**根运行**才独占会话
    await queryRunner.query(`DROP INDEX "public"."uk_run_active_conversation"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_active_conversation" ON "runs" ("conversation_id") WHERE parent_run_id IS NULL AND status IN ('pending','running')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_tool_call" ON "runs" ("parent_run_id", "tool_call_id") WHERE tool_call_id IS NOT NULL`,
    );
    await queryRunner.query(`CREATE INDEX "idx_run_parent" ON "runs" ("parent_run_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_run_parent"`);
    await queryRunner.query(`DROP INDEX "public"."uk_run_tool_call"`);
    await queryRunner.query(`DROP INDEX "public"."uk_run_active_conversation"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uk_run_active_conversation" ON "runs" ("conversation_id") WHERE status IN ('pending','running')`,
    );
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "tool_call_id"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "depth"`);
    await queryRunner.query(`ALTER TABLE "runs" DROP COLUMN "parent_run_id"`);
  }
}
