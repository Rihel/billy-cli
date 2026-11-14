import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { MonitorRuleConfigSchema, type MonitorRuleConfig } from '@repo/shared'
import type { EventRuleType, Hit, MonitorErrorEvent } from '../definitions/rule.types.js'
import { AlertDeliveryService } from './alert-delivery.service.js'
import { AlertLifecycleService } from './alert-lifecycle.service.js'
import { MonitorInstanceService } from './instance.service.js'
import { MonitorRuleRepository } from './monitor-rule.repository.js'
import { RuleRegistry } from './rule.registry.js'

/** 事件规则：异常入口直接驱动，不走指标槽 */
@Injectable()
export class EventRuleService {
  constructor(
    @Inject(RuleRegistry) private readonly rules: RuleRegistry,
    @Inject(MonitorRuleRepository) private readonly ruleRows: MonitorRuleRepository,
    @Inject(AlertLifecycleService) private readonly lifecycle: AlertLifecycleService,
    @Inject(AlertDeliveryService) private readonly delivery: AlertDeliveryService,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(MonitorInstanceService) private readonly instance: MonitorInstanceService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async ingest(event: MonitorErrorEvent): Promise<void> {
    const rows = await this.ruleRows.findEnabledByKind('event')
    for (const row of rows) {
      const rule = this.rules.get(row.ruleKey)
      if (!rule || rule.kind !== 'event') continue

      let config: MonitorRuleConfig
      try {
        config = MonitorRuleConfigSchema.parse({ ...rule.defaults, ...row.config })
      } catch (error) {
        this.logger.error('monitor.event.config_invalid', { ruleKey: rule.key, error })
        continue
      }
      if (!rule.matchEvent(event, config)) continue

      const windowMs = rule.windowSeconds * 1000
      const bucket = Math.floor(event.at.getTime() / windowMs) * windowMs
      const windowKey = new Date(bucket).toISOString()
      const countKey = `monitor:event:${rule.key}:${windowKey}`
      const count = await this.redis.incr(countKey)
      if (count === 1) await this.redis.expire(countKey, rule.windowSeconds * 2)
      if (count < config.threshold) continue

      const fireKey = `monitor:event:fire:${rule.key}:${windowKey}`
      const token = await this.redis.acquireLock(fireKey, rule.windowSeconds * 2)
      if (!token) continue

      try {
        const windowEnd = new Date(bucket + windowMs)
        const alert = await this.lifecycle.createEventAlert(
          rule,
          row,
          config,
          event,
          count,
          windowKey,
          event.at,
          this.instance.id,
        )
        const hit: Hit = {
          ruleKey: rule.key,
          subjectId: alert.subjectId,
          value: count,
          threshold: config.threshold,
          windowStart: new Date(bucket),
          windowEnd,
          samples: [],
        }
        const delivered = await this.delivery.deliver({
          alert,
          rule,
          row,
          config,
          hit,
          window: { key: windowKey, start: new Date(bucket), end: windowEnd },
          event,
        })
        if (!delivered) {
          // 全通道失败：删 fire 键，下一次事件还能重试
          await this.redis.del(fireKey)
        }
      } catch (error) {
        this.logger.error('monitor.event.failed', { ruleKey: rule.key, error })
        await this.redis.del(fireKey)
      }
    }
  }

  /** 事件规则恢复：60 秒槽扫一遍，长时间没有新事件就 resolved */
  async sweep(now: Date): Promise<void> {
    const rows = await this.ruleRows.findEnabledByKind('event')
    for (const row of rows) {
      const rule = this.rules.get(row.ruleKey)
      if (!rule || rule.kind !== 'event') continue
      try {
        const config: MonitorRuleConfig = MonitorRuleConfigSchema.parse({
          ...rule.defaults,
          ...row.config,
        })
        await this.lifecycle.resolveLapsed(rule as EventRuleType, row, config, now)
      } catch (error) {
        this.logger.error('monitor.event.sweep_failed', { ruleKey: rule.key, error })
      }
    }
  }
}
