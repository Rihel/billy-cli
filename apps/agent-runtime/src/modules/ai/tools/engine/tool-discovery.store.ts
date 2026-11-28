import { Inject, Injectable } from '@nestjs/common'
import { RedisStore } from '@repo/kits'

/** 会话级“搜到过的外部工具”保留多久：会话闲置多天后再回来仍可续跑 */
const TTL_SECONDS = 7 * 24 * 60 * 60
/** 一次会话最多记多少个：防止模型反复搜索把工具面撑爆 */
const MAX_KEYS = 50

/**
 * **搜到过的工具**（会话级，Redis）。
 *
 * 外部服务（MCP / 手工登记）不随工具面一起下发：模型先用 `tool-search` 找到 key，
 * 这里记下来，下一轮 `resolveTools` 再把它们补进工具面。
 *
 * 为什么按会话而不是按轮：同一轮里工具面是固定的（Mastra 不支持中途换工具），
 * 按会话记才能让“这一轮搜到、下一轮就能调”成立；也避免每轮重新搜。
 */
@Injectable()
export class ToolDiscoveryStore {
  constructor(@Inject(RedisStore) private readonly redis: RedisStore) {}

  private key(conversationId: string): string {
    return `ai:tool:discovered:${conversationId}`
  }

  /** 记下一批 key（去重、保留最近 MAX_KEYS 个） */
  async remember(conversationId: string, keys: readonly string[]): Promise<void> {
    const incoming = keys.filter((key) => typeof key === 'string' && key.trim())
    if (incoming.length === 0) return
    const current = new Set(await this.list(conversationId))
    for (const key of incoming) current.add(key)
    const kept = [...current].slice(-MAX_KEYS)
    await this.redis.setJson(this.key(conversationId), kept, TTL_SECONDS)
  }

  /** 这个会话搜到过哪些 key（按记录顺序） */
  async list(conversationId: string): Promise<string[]> {
    const value = await this.redis.getJson<string[]>(this.key(conversationId))
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string' && key.trim()) : []
  }
}
