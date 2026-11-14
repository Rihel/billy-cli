import { Inject, Injectable } from '@nestjs/common'
import { AiProviderKeyEntity } from '@repo/db'
import { AppLogger, Db, RedisStore } from '@repo/kits'

interface CachedKeys {
  at: number
  keys: AiProviderKeyEntity[]
}

export interface PickedKey {
  keyId: string | null
  secret: string | null
}

const KEY_CACHE_TTL_MS = 30_000
const COOLDOWN_SECONDS = 30
const COOLDOWN_AUTH_SECONDS = 300
const DISABLE_AFTER_FAILURES = 3

/**
 * 上游 key 池（`ai_provider_keys`）。
 *
 * - 选择：`status=active` → 未被冷却 → 未超 rpm / 日 token / 日成本额度 → 权重降序、最近最少用；
 * - 额度预占：选中后 `INCR` 分钟计数（rpm）；日额度在记账时累加；
 * - 429 → 冷却 30s；401/403 → 冷却 300s + 失败计数，连续 3 次置 `disabled`（人工恢复）；
 * - 没有 key 行时回落到 `ai_providers.api_key`（兼容旧配置）。
 */
@Injectable()
export class ProviderKeyService {
  private readonly cache = new Map<string, CachedKeys>()

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 配置变更事件：清 key 缓存 */
  clearCache(): void {
    this.cache.clear()
  }

  async pick(providerId: string, fallbackSecret: string | null): Promise<PickedKey> {
    const keys = await this.keys(providerId)
    if (keys.length === 0) {
      const secret = fallbackSecret?.trim()
      return { keyId: null, secret: secret || null }
    }
    for (const key of keys) {
      if (await this.redis.get(coolKey(key.id))) continue
      if (key.rpm && (await this.current(minuteKey(key.id))) >= key.rpm) continue
      if (key.dailyTokens && (await this.current(dayKey('tokens', key.id))) >= key.dailyTokens) {
        continue
      }
      if (
        key.dailyCostMicros &&
        (await this.current(dayKey('cost', key.id))) >= key.dailyCostMicros
      ) {
        continue
      }
      const rpm = await this.redis.incr(minuteKey(key.id))
      if (rpm === 1) await this.redis.expire(minuteKey(key.id), 60)
      return { keyId: key.id, secret: key.secret }
    }
    return { keyId: null, secret: null }
  }

  /** 429：短暂冷却；401/403：长冷却 + 失败计数（连续 3 次停用） */
  async penalize(keyId: string | null, httpStatus: number): Promise<void> {
    if (!keyId) return
    if (httpStatus === 401 || httpStatus === 403) {
      await this.redis.set(coolKey(keyId), '1', COOLDOWN_AUTH_SECONDS)
      const repo = this.db.getRepository(AiProviderKeyEntity)
      const row = await repo.findOne({ where: { id: keyId } })
      if (!row) return
      const failures = row.failureCount + 1
      await repo.update(keyId, {
        failureCount: failures,
        ...(failures >= DISABLE_AFTER_FAILURES ? { status: 'disabled' } : {}),
      })
      if (failures >= DISABLE_AFTER_FAILURES) {
        this.logger.warn('model.gateway.key_disabled', { keyId, failures })
      }
      return
    }
    if (httpStatus === 429) {
      await this.redis.set(coolKey(keyId), '1', COOLDOWN_SECONDS)
    }
  }

  /** 记该 key 的日 token / 日成本（记账后调用；keyId 为 null 表示回落供应商 key） */
  async recordUsage(
    keyId: string | null,
    tokens: number | null,
    costMicros: number | null,
  ): Promise<void> {
    if (!keyId) return
    if (tokens) await this.incrDaily(dayKey('tokens', keyId), tokens)
    if (costMicros) await this.incrDaily(dayKey('cost', keyId), costMicros)
  }

  private async keys(providerId: string): Promise<AiProviderKeyEntity[]> {
    const cached = this.cache.get(providerId)
    if (cached && Date.now() - cached.at < KEY_CACHE_TTL_MS) return cached.keys
    const keys = await this.db.getRepository(AiProviderKeyEntity).find({
      where: { providerId, status: 'active' },
      order: { weight: 'DESC', lastUsedAt: 'ASC' },
    })
    this.cache.set(providerId, { at: Date.now(), keys })
    return keys
  }

  private async current(key: string): Promise<number> {
    const raw = await this.redis.get(key)
    return raw === null ? 0 : Number(raw)
  }

  private async incrDaily(key: string, amount: number): Promise<void> {
    const value = await this.redis.incrBy(key, amount)
    if (value === amount) await this.redis.expire(key, 2 * 24 * 60 * 60)
  }
}

const today = (): string => new Date().toISOString().slice(0, 10)
const minuteOf = (): string => new Date().toISOString().slice(0, 16)
const coolKey = (keyId: string): string => `gw:key:cool:${keyId}`
const minuteKey = (keyId: string): string => `gw:key:rpm:${keyId}:${minuteOf()}`
const dayKey = (kind: string, keyId: string): string => `gw:key:day:${today()}:${kind}:${keyId}`
