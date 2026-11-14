import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `ai_tools` 加 **自定义事件声明镜像** 列（设计 §5.17，2026-10-01）。
 *
 * 与 `param_schema` 同一口径：事件声明是不可变的基础信息，**留在代码**、启动期由种子同步
 * **全量覆盖**写进这一列，管理台只读展示 —— 于是"这个工具会往流里吐什么"在库里查得到，
 * 又能与代码声明对账（跑两次同步结果一致）。
 *
 * 为什么 `NOT NULL DEFAULT '[]'`：事件是**列表**，"没有事件"（`[]`）与"还没同步过"（NULL）
 * 是两件事；给默认空数组后，历史行就地补成 `[]`，不需要回填脚本，读侧也不必再判空。
 */
export class AiToolEvents1790844120306 implements MigrationInterface {
  name = 'AiToolEvents1790844120306'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_tools" ADD "events" jsonb NOT NULL DEFAULT '[]'`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_tools" DROP COLUMN "events"`)
  }
}
