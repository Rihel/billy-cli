import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'
import { AppLogger, EventBus } from '@repo/kits'
import { SkillLibraryService } from './skill.service.js'

/** 与 main 的 `SKILL_CHANGE_TOPIC` 保持一致；跨服务契约只增不改 */
export const SKILL_CHANGE_TOPIC = 'ai.skill.changed'

interface SkillChangeEvent {
  skillKey: string
  action: 'upsert' | 'remove'
  version: number
}

/**
 * main 写完技能库后发事件；runtime 负责从 DB 读全量文件并落盘/刷新 loader。
 *
 * Redis Pub/Sub 是 at-most-once，漏事件由 runtime 启动 `syncAll` 自愈；
 * 这里不反向调用 main。
 */
@Injectable()
export class SkillChangeSubscriber implements OnApplicationBootstrap, OnApplicationShutdown {
  private unsubscribe?: () => void

  constructor(
    @Inject(EventBus) private readonly events: EventBus,
    @Inject(SkillLibraryService) private readonly skills: SkillLibraryService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.events.subscribe<SkillChangeEvent>(SKILL_CHANGE_TOPIC, (event) => {
      void this.apply(event).catch((error: unknown) => {
        this.logger.error('ai.skill.change_apply_failed', {
          skillKey: event?.skillKey,
          action: event?.action,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    })
  }

  onApplicationShutdown(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private async apply(event: SkillChangeEvent): Promise<void> {
    if (!event?.skillKey) return
    await this.skills.syncFromDatabase(event.skillKey, event.action === 'remove')
  }
}
