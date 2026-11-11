import type { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * 工具 key 改名：`run-command` → `bash`。
 *
 * 为什么要迁移：`ai_tools` 里可能存着人工改过的开关 / 限额 / 工作目录 / 秘钥；
 * 只改代码里的 key 会让旧配置变成一条"注册表里不存在的孤儿行"，新 key 拿到默认值，
 * 用户会以为"我配的东西丢了"。
 *
 * 两条边界：
 * - **只在 `bash` 尚不存在时改名**（唯一键冲突时不能硬来；两行都在说明已经跑过新版本，
 *   旧行保留只影响审计视角，不影响运行）；
 * - **历史时间线的 `tool_key` 不动**：那是审计证据，保留当时的名字。
 */
export class RenameRunCommandToBash1794325500000 implements MigrationInterface {
  name = 'RenameRunCommandToBash1794325500000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "ai_tools" AS old
      SET "tool_key" = 'bash', "updated_at" = now()
      WHERE old."tool_key" = 'run-command'
        AND NOT EXISTS (SELECT 1 FROM "ai_tools" AS current WHERE current."tool_key" = 'bash')
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "ai_tools" AS renamed
      SET "tool_key" = 'run-command', "updated_at" = now()
      WHERE renamed."tool_key" = 'bash'
        AND NOT EXISTS (SELECT 1 FROM "ai_tools" AS old WHERE old."tool_key" = 'run-command')
    `)
  }
}
