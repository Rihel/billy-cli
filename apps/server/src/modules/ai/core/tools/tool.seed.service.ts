import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import { ToolRegistry } from './tool.registry.js'
import { ToolConfigRepository } from './tool.config.repository.js'

/**
 * 工具配置的**种子同步**（设计 §5.4 / §6.4）：启动时把代码声明写进 `ai_tools`。
 *
 * 三条口径：
 * - `tool_key` 是幂等锚点：存在则更新、不存在则插入（跑两次结果一致）；
 * - `source='manual'` 的行**只更新 `last_seen_at`**（人的决定不被同步冲掉）；
 * - 代码里删掉的工具**保留配置行** —— 历史 run 的时间线还引用着这个 key，删了就查不出"当年配了什么"。
 *
 * 失败**不拖垮启动**（AI 能力整体不可用是可接受状态，页面会提示），但必须 error 日志。
 */
@Injectable()
export class ToolSeedService implements OnApplicationBootstrap {
  constructor(
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    @Inject(ToolConfigRepository) private readonly repository: ToolConfigRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const specs = this.registry.specs()
    try {
      let created = 0
      let updated = 0
      for (const spec of specs) {
        const result = await this.repository.upsertSeed(spec)
        if (result === 'created') created += 1
        else if (result === 'updated') updated += 1
      }
      this.logger.log('ai.tool.seed_done', {
        total: specs.length,
        created,
        updated,
        keys: specs.map((spec) => spec.key),
      })
    } catch (error) {
      this.logger.error('工具配置种子同步失败（已跳过，不影响启动）', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
