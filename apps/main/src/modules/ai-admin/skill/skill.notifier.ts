import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, EventBus } from '@repo/kits'
import {
  SKILL_CHANGE_TOPIC,
  type SkillChangeEvent,
  type SkillChangeNotifier,
} from './skill.ports.js'

/**
 * 基于 Redis Pub/Sub 的技能变更通知（kits `EventBus`）。
 *
 * 为什么用 `EventBus` 而不是直接操作 ioredis：频道前缀、实例自回环过滤、断线重订阅
 * 都由 kits 统一处理；main 只关心「发一条领域事件」。
 *
 * 发布失败（Redis 不可用）**只记日志不抛错**：DB 已经提交，此时把接口判失败会让用户
 * 重试并重复写入；runtime 的启动自愈与下一次变更会补上落盘。
 */
@Injectable()
export class EventBusSkillChangeNotifier implements SkillChangeNotifier {
  constructor(
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async notify(event: SkillChangeEvent): Promise<boolean> {
    try {
      const published = await this.eventBus.publish(SKILL_CHANGE_TOPIC, event)
      if (!published) {
        this.logger.warn('ai.skill.change_notify_not_broadcast', {
          skillKey: event.skillKey,
          action: event.action,
        })
      }
      return published
    } catch (error) {
      this.logger.error('ai.skill.change_notify_failed', {
        skillKey: event.skillKey,
        action: event.action,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }
}
