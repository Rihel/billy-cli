import { createHash } from 'node:crypto'
import { inject, injectable } from 'inversify'
import { AppConfig } from '../foundation/app-config.js'
import { RedisStoreError } from '../foundation/errors/infrastructure-errors.js'
import { RedisStore } from './redis-store.js'

export type SessionType = 'user' | 'admin'

/** 服务端会话主体：sub 为实体 id，type 区分前台用户 / 后台管理员 */
export interface SessionSubject {
  sub: string
  type: SessionType
}

const sessionKey = (sha: string) => `auth:session:${sha}`
const indexKey = (type: SessionType, sub: string) => `auth:index:${type}:${sub}`

/**
 * 服务端会话门面（Redis）：
 * 登录/注册签发 JWT 后登记会话，每次请求校验 JWT 的同时查 Redis 会话，
 * 登出 / 禁用 / 删除时撤销会话 —— 实体状态变更对已签发 token 即时生效。
 *
 * key 设计（redis.keyPrefix 由 RedisStore 统一追加）：
 * - `auth:session:{sha256(token)}` → JSON { sub, type }，TTL 与 JWT 有效期一致
 * - `auth:index:{type}:{sub}` → Set 存该主体的全部会话 sha，供批量踢人
 */
@injectable()
export class SessionStore {
  constructor(
    @inject(AppConfig) private readonly config: AppConfig,
    @inject(RedisStore) private readonly redis: RedisStore,
  ) {}

  /** 会话 TTL 与 JWT 有效期一致（支持 300 / 7d / 30m 等格式，兜底 7 天） */
  private ttlSeconds(): number {
    const raw = this.config.jwt.expiresIn.trim()
    const match = /^(\d+)([smhd])?$/.exec(raw)
    if (!match) return 7 * 24 * 60 * 60
    const factors: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
    return Number(match[1]) * factors[match[2] ?? 's']
  }

  private sha(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /** 登录 / 注册成功：登记服务端会话，并加入 subject 索引（供批量踢人） */
  async create(token: string, subject: SessionSubject): Promise<void> {
    try {
      const sha = this.sha(token)
      await this.redis.setJson(sessionKey(sha), subject, this.ttlSeconds())
      await this.redis.raw.sadd(indexKey(subject.type, subject.sub), sha)
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 每次请求校验：JWT 验签通过后查 Redis 会话，不存在即视为无效 */
  async verify(token: string): Promise<SessionSubject | null> {
    try {
      return await this.redis.getJson<SessionSubject>(sessionKey(this.sha(token)))
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 登出：撤销单个会话（幂等，会话不存在时静默成功） */
  async revoke(token: string): Promise<void> {
    try {
      const sha = this.sha(token)
      const session = await this.redis.getJson<SessionSubject>(sessionKey(sha))
      await this.redis.del(sessionKey(sha))
      if (session) {
        await this.redis.raw.srem(indexKey(session.type, session.sub), sha)
      }
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 禁用 / 删除实体：撤销其全部会话（立即踢下线） */
  async revokeAll(type: SessionType, sub: string): Promise<void> {
    try {
      const index = indexKey(type, sub)
      const shas = await this.redis.raw.smembers(index)
      if (shas.length > 0) {
        await this.redis.del(...shas.map(sessionKey))
      }
      await this.redis.del(index)
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }
}
