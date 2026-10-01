import type { MigrationInterface, QueryRunner } from "typeorm"

/**
 * 工具结果分页的**回取**路径：按 `(conversation_id, tool_call_id)` 找工具原文（设计 §5.6）。
 *
 * 为什么需要它：分页句柄在**跨轮 / 跨实例**时靠时间线里的原文兜底（同轮走进程内内存），
 * 而原文的定位键是"会话 + 那次工具调用"，`uk_timeline_tool_call`（run_id + tool_call_id + kind）
 * 不吃这个查询。
 *
 * 生成后手工核对过：部分索引条件 `WHERE tool_call_id IS NOT NULL` 与实体声明一致
 * （`timelines` 里还有非工具行，条件不加会把整表都索引进去）。
 */
export class TimelineToolCallIndex1790823772623 implements MigrationInterface {
  name = 'TimelineToolCallIndex1790823772623'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "idx_timeline_conversation_tool_call" ON "timelines" ("conversation_id", "tool_call_id") WHERE tool_call_id IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."idx_timeline_conversation_tool_call"`)
  }
}
