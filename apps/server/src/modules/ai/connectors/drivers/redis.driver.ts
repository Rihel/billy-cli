import { Injectable } from '@nestjs/common'
import { Redis } from 'ioredis'
import { z } from 'zod'
import { ToolDeniedError } from '../../core/tools/tools.types.js'
import type { Capability, ConnectorDriver, ConnectorFieldDecl, ConnectorRuntime } from '../connector.types.js'

/**
 * **Redis 驱动**（设计 `docs/design/ai-connector.md` §3.11）。
 *
 * 只读，而且**没有"执行任意命令"的口子**：工具写死三个（扫键 / 取字符串 / 取哈希），
 * 命令白名单就是这三个实现本身——比"解析用户命令再拦黑名单"安全得多。
 *
 * 键范围：`keyPrefix` 配了就只允许读该前缀下的键（`scan_keys` 自动拼接，`get` / `hgetall` 先校验）。
 * 超时与连接：`connectTimeout` + 命令级超时（ioredis 的 `commandTimeout`）。
 */

const RedisConfig = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65_535).default(6379),
  /** 逻辑库编号 */
  db: z.number().int().min(0).max(15).default(0),
  /** 键前缀（空 = 不限）；只约束读，不改变实际 key */
  keyPrefix: z.string().default(''),
  /** 单次最多返回多少条（scan / hgetall） */
  maxItems: z.number().int().positive().max(1_000).default(100),
  commandTimeoutMs: z.number().int().positive().max(30_000).default(5_000),
})

type RedisConfigValue = z.infer<typeof RedisConfig>

const SCAN_INPUT = {
  type: 'object',
  properties: {
    pattern: { type: 'string', description: '匹配模式，如 user:*（与配置的键前缀取交集）' },
  },
} as const

const KEY_INPUT = {
  type: 'object',
  properties: { key: { type: 'string', description: '键名（必须在配置的键前缀之内）' } },
  required: ['key'],
} as const

@Injectable()
export class RedisDriver implements ConnectorDriver {
  readonly kind = 'redis'
  readonly transport = 'db' as const
  readonly config = RedisConfig
  readonly secrets: readonly ConnectorFieldDecl[] = []
  readonly auth = { base: 'none' as const, subject: 'none' as const }

  private readonly clients = new Map<string, Redis>()

  async describe(): Promise<Capability[]> {
    return [
      {
        kind: 'tool',
        name: 'scan_keys',
        title: '扫键',
        description: '按匹配模式扫键（SCAN，最多返回配置里定的条数），不读值',
        inputSchema: SCAN_INPUT,
        risk: 'read',
      },
      {
        kind: 'tool',
        name: 'get',
        title: '读字符串',
        description: '读一个键的字符串值（GET）',
        inputSchema: KEY_INPUT,
        risk: 'read',
      },
      {
        kind: 'tool',
        name: 'hgetall',
        title: '读哈希',
        description: '读一个键的全部哈希字段（HGETALL）',
        inputSchema: KEY_INPUT,
        risk: 'read',
      },
    ]
  }

  async invoke(rt: ConnectorRuntime, tool: string, input: unknown): Promise<unknown> {
    const config = RedisConfig.parse(rt.config)
    const client = await this.clientOf(rt, config)

    try {
      return await this.dispatch(client, config, tool, input)
    } catch (error) {
      if (error instanceof ToolDeniedError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('WRONGTYPE')) {
        throw new ToolDeniedError(
          'invalid-input',
          '这个键的类型不是字符串 / 哈希',
          '先用 scan_keys 找到键，再用对应类型的工具（hgetall / get）',
        )
      }
      throw forRedisError(message)
    }
  }

  private async dispatch(
    client: Redis,
    config: RedisConfigValue,
    tool: string,
    input: unknown,
  ): Promise<unknown> {
    switch (tool) {
      case 'scan_keys': {
        const { pattern } = z.object({ pattern: z.string().max(256).default('*') }).parse(input ?? {})
        const full = `${config.keyPrefix}${pattern}`
        const keys: string[] = []
        let cursor = '0'
        do {
          const [next, batch] = await client.scan(cursor, 'MATCH', full, 'COUNT', 200)
          cursor = next
          keys.push(...batch)
        } while (cursor !== '0' && keys.length < config.maxItems)
        const trimmed = keys.slice(0, config.maxItems)
        return { keys: trimmed, truncated: keys.length > trimmed.length }
      }
      case 'get': {
        const { key } = z.object({ key: z.string().min(1).max(512) }).parse(input)
        this.assertKeyInScope(config, key)
        const value = await client.get(key)
        return { key, value }
      }
      case 'hgetall': {
        const { key } = z.object({ key: z.string().min(1).max(512) }).parse(input)
        this.assertKeyInScope(config, key)
        const flat = await client.hgetall(key)
        const entries = Object.entries(flat)
        return {
          key,
          fields: Object.fromEntries(entries.slice(0, config.maxItems)),
          truncated: entries.length > config.maxItems,
        }
      }
      default:
        throw new ToolDeniedError('unknown-tool', `驱动 ${this.kind} 没有工具 ${tool}`)
    }
  }

  async probe(rt: ConnectorRuntime): Promise<{ ok: boolean; message?: string }> {
    try {
      const client = await this.clientOf(rt, RedisConfig.parse(rt.config))
      const pong = await client.ping()
      return { ok: pong === 'PONG', message: pong === 'PONG' ? undefined : `PING 返回 ${pong}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async dispose(instanceId: string): Promise<void> {
    const client = this.clients.get(instanceId)
    this.clients.delete(instanceId)
    if (!client) return
    try {
      await client.quit()
    } catch {
      client.disconnect()
    }
  }

  private async clientOf(rt: ConnectorRuntime, config: RedisConfigValue): Promise<Redis> {
    const existing = this.clients.get(rt.instanceId)
    if (existing) return existing

    const client = new Redis({
      host: config.host,
      port: config.port,
      db: config.db,
      password: rt.secrets.password || undefined,
      lazyConnect: true,
      connectTimeout: 5_000,
      commandTimeout: config.commandTimeoutMs,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    client.on('error', () => undefined) // 错误由调用侧结论表达，不在这里刷日志
    this.clients.set(rt.instanceId, client)

    try {
      await client.connect()
    } catch (error) {
      this.clients.delete(rt.instanceId)
      client.disconnect()
      throw new ToolDeniedError('upstream', `连不上 Redis：${error instanceof Error ? error.message : String(error)}`)
    }
    return client
  }

  /** 键必须在配置的前缀之内（前缀为空 = 不限） */
  private assertKeyInScope(config: RedisConfigValue, key: string): void {
    if (config.keyPrefix && !key.startsWith(config.keyPrefix)) {
      throw new ToolDeniedError(
        'invalid-input',
        `键不在允许的前缀内（${config.keyPrefix}）`,
        '换用该前缀下的键，或让管理员调整前缀',
      )
    }
  }
}

/** Redis 的常见错误分类（读不懂的就当外部服务异常） */
const forRedisError = (message: string): ToolDeniedError => {
  if (/NOAUTH|WRONGPASS|invalid password/i.test(message)) {
    return new ToolDeniedError('precheck-failed', 'Redis 认证失败', '让管理员检查连接器里的密码')
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connect/i.test(message)) {
    return new ToolDeniedError('upstream', `连不上 Redis：${message}`, '检查地址与网络')
  }
  return new ToolDeniedError('upstream', `Redis 操作失败：${message}`)
}
