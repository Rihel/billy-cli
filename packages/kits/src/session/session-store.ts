import { createHash } from 'node:crypto'
import { Inject, Injectable } from '@nestjs/common'
import { JwtConfig } from '../jwt/jwt.config.js'
import { IdGeneration } from '../foundation/id-generation/id-generation.js'
import { RedisStoreError } from '../foundation/errors/infrastructure-errors.js'
import { RedisStore } from '../redis/redis-store.js'

export type SessionType = 'user' | 'admin'

/** 服务端会话主体：sub 为实体 id，type 区分前台用户 / 后台管理员 */
export interface SessionSubject {
  sub: string
  type: SessionType
}

/** 创建会话时采集的元数据（登录设备列表用；取不到为 null） */
export interface SessionMeta {
  ip?: string | null
  userAgent?: string | null
}

/** 会话条目（对外暴露给前端；**不含** token 派生值） */
export interface SessionEntry {
  /** 会话标识（随机、不可由 token 推导），下线某台设备时用它 */
  sessionId: string
  /** 创建时间（epoch ms） */
  createdAt: number
  /** 最后活跃时间（epoch ms；按 60s 节流写回，精度为分钟级） */
  lastSeenAt: number
  ip: string | null
  userAgent: string | null
}

export interface SessionListResult {
  entries: SessionEntry[]
  /** 当前请求所用 token 对应的会话 id（无 token / 会话已失效为 null） */
  currentSessionId: string | null
}

/**
 * 会话存储负载（Redis JSON）。除主体外全部字段可选 —— 升级前登记的旧会话没有这些字段，
 * `list()` 会就地补写（见 `ensureSession`），避免出现「列不出来又删不掉」的僵尸条目。
 */
interface StoredSession extends SessionSubject {
  sessionId?: string
  createdAt?: number
  lastSeenAt?: number
  /** 会话绝对到期时间：写回时据此算**剩余** TTL，避免把会话寿命越刷越长（JWT 才是权威寿命） */
  expiresAt?: number
  ip?: string | null
  userAgent?: string | null
}

/** 补全后的会话负载（内部使用） */
type ResolvedSession = Required<
  Pick<
    StoredSession,
    'sub' | 'type' | 'sessionId' | 'createdAt' | 'lastSeenAt' | 'expiresAt' | 'ip' | 'userAgent'
  >
>

const sessionKey = (sha: string) => `auth:session:${sha}`
const indexKey = (type: SessionType, sub: string) => `auth:index:${type}:${sub}`
const sidKey = (type: SessionType, sub: string, sessionId: string) =>
  `auth:sid:${type}:${sub}:${sessionId}`

/** `lastSeenAt` 写回节流窗口：verify 每请求都跑，不加节流会把 Redis 变成写热点 */
const TOUCH_INTERVAL_MS = 60_000

/**
 * 服务端会话统一入口（Redis）：
 * 登录/注册签发 JWT 后登记会话，每次请求校验 JWT 的同时查 Redis 会话，
 * 登出 / 禁用 / 删除时撤销会话 —— 实体状态变更对已签发 token 即时生效。
 * 另提供「登录设备列表 + 单设备下线」（用户在个人中心管理自己的登录设备）。
 *
 * key 设计（redis.keyPrefix 由 RedisStore 统一追加）：
 * - `auth:session:{sha256(token)}` → JSON 会话负载（主体 + sessionId + 时间 + ip / userAgent）
 * - `auth:sid:{type}:{sub}:{sessionId}` → sha（单设备下线的 O(1) 反查，不必遍历）
 * - `auth:index:{type}:{sub}` → Set 存该主体的全部会话 sha（批量踢人 + 列表遍历）
 *
 * 列表相关的两个卫生问题：索引 Set 成员会随 session key 到期变成「僵尸」（list 时修剪），
 * 索引自身也设与会话相同的 TTL（每次登录刷新），二者同时到期、不会互相残留。
 */
@Injectable()
export class SessionStore {
  constructor(
    @Inject(JwtConfig) private readonly config: JwtConfig,
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(IdGeneration) private readonly idGeneration: IdGeneration,
  ) {}

  /** 会话 TTL 与 JWT 有效期一致（支持 300 / 7d / 30m 等格式，兜底 7 天） */
  private ttlSeconds(): number {
    const raw = this.config.expiresIn.trim()
    const match = /^(\d+)([smhd])?$/.exec(raw)
    if (!match) return 7 * 24 * 60 * 60
    const factors: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }
    return Number(match[1]) * factors[match[2] ?? 's']
  }

  private sha(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  /** 登录 / 注册成功：登记服务端会话（含元数据），并写入主体索引 */
  async create(token: string, subject: SessionSubject, meta: SessionMeta = {}): Promise<void> {
    try {
      const ttl = this.ttlSeconds()
      const now = Date.now()
      const session = {
        ...subject,
        sessionId: this.idGeneration.next(24),
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + ttl * 1000,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent ?? null,
      } satisfies StoredSession

      const sha = this.sha(token)
      await this.redis.setJson(sessionKey(sha), session, ttl)
      await this.redis.set(sidKey(subject.type, subject.sub, session.sessionId), sha, ttl)
      await this.redis.raw.sadd(indexKey(subject.type, subject.sub), sha)
      // 索引与会话同时到期：否则会话过期后索引会永久残留
      await this.redis.expire(indexKey(subject.type, subject.sub), ttl)
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /**
   * 每次请求校验：JWT 验签通过后查 Redis 会话，不存在即视为无效。
   * 顺带节流刷新 `lastSeenAt`（best-effort，失败不影响校验结果）。
   */
  async verify(token: string): Promise<SessionSubject | null> {
    try {
      const sha = this.sha(token)
      const payload = await this.redis.getJson<StoredSession>(sessionKey(sha))
      if (!payload) return null
      void this.touch(sha, payload)
      return payload
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 登出：撤销单个会话（幂等，会话不存在时静默成功） */
  async revoke(token: string): Promise<void> {
    try {
      const sha = this.sha(token)
      const payload = await this.redis.getJson<StoredSession>(sessionKey(sha))
      await this.redis.del(sessionKey(sha))
      if (payload) {
        if (payload.sessionId) {
          await this.redis.del(sidKey(payload.type, payload.sub, payload.sessionId))
        }
        await this.redis.raw.srem(indexKey(payload.type, payload.sub), sha)
      }
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /**
   * 登录设备列表：当前身份的会话，按最后活跃倒序，并标出当前会话。
   * 同时做两件卫生工作：修剪已过期会话的索引成员、给旧会话补 sessionId。
   */
  async list(type: SessionType, sub: string, currentToken?: string): Promise<SessionListResult> {
    try {
      const index = indexKey(type, sub)
      const shas = await this.redis.raw.smembers(index)
      if (shas.length === 0) return { entries: [], currentSessionId: null }

      const currentSha = currentToken ? this.sha(currentToken) : null
      const payloads = await Promise.all(
        shas.map((sha) =>
          this.redis.getJson<StoredSession>(sessionKey(sha)).catch(() => null),
        ),
      )

      const entries: SessionEntry[] = []
      const stale: string[] = []
      let currentSessionId: string | null = null

      for (let i = 0; i < shas.length; i += 1) {
        const sha = shas[i]
        const payload = payloads[i]
        if (!payload) {
          // session key 已按 TTL 过期：索引里的成员属于残留，顺手清掉
          stale.push(sha)
          continue
        }

        const session = await this.ensureSession(sha, payload)
        if (sha === currentSha) currentSessionId = session.sessionId
        entries.push({
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          lastSeenAt: session.lastSeenAt,
          ip: session.ip,
          userAgent: session.userAgent,
        })
      }

      if (stale.length > 0) await this.redis.raw.srem(index, ...stale)
      entries.sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      return { entries, currentSessionId }
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 单设备下线（幂等）：会话已失效 / sessionId 不存在时返回 false，不抛错 */
  async revokeById(type: SessionType, sub: string, sessionId: string): Promise<boolean> {
    try {
      const sha = await this.redis.raw.get(sidKey(type, sub, sessionId))
      if (!sha) return false
      await this.redis.del(sessionKey(sha))
      await this.redis.del(sidKey(type, sub, sessionId))
      await this.redis.raw.srem(indexKey(type, sub), sha)
      return true
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
        const payloads = await Promise.all(
          shas.map((sha) =>
            this.redis.getJson<StoredSession>(sessionKey(sha)).catch(() => null),
          ),
        )
        // 反查 key 也要一起删：否则它会独自残留到 TTL 到期
        const sidKeys = payloads
          .map((payload) => payload?.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId))
          .map((sessionId) => sidKey(type, sub, sessionId))

        await this.redis.del(...shas.map(sessionKey), ...sidKeys)
      }
      await this.redis.del(index)
    } catch (cause) {
      throw new RedisStoreError(cause)
    }
  }

  /** 节流刷新最后活跃时间（按剩余寿命写回，不延长会话） */
  private async touch(sha: string, payload: StoredSession): Promise<void> {
    try {
      const now = Date.now()
      const lastSeenAt = payload.lastSeenAt ?? 0
      if (now - lastSeenAt < TOUCH_INTERVAL_MS) return

      const expiresAt = payload.expiresAt ?? now + (await this.remainingTtl(sha)) * 1000
      const remaining = Math.floor((expiresAt - now) / 1000)
      if (remaining <= 0) return

      await this.redis.setJson(sessionKey(sha), { ...payload, lastSeenAt: now }, remaining)
    } catch {
      // 写回失败不影响会话校验（本方法为旁路）
    }
  }

  /** 剩余 TTL（秒）：旧会话没有 expiresAt 时按 Redis 实际剩余寿命推算 */
  private async remainingTtl(sha: string): Promise<number> {
    const ttl = await this.redis.ttl(sessionKey(sha))
    return ttl > 0 ? ttl : this.ttlSeconds()
  }

  /** 旧会话（升级前登记，无 sessionId / 时间字段）就地补写，保证列表可展示、可下线 */
  private async ensureSession(sha: string, payload: StoredSession): Promise<ResolvedSession> {
    if (
      payload.sessionId &&
      payload.createdAt !== undefined &&
      payload.lastSeenAt !== undefined
    ) {
      return {
        ...payload,
        sessionId: payload.sessionId,
        createdAt: payload.createdAt,
        lastSeenAt: payload.lastSeenAt,
        expiresAt: payload.expiresAt ?? Date.now(),
        ip: payload.ip ?? null,
        userAgent: payload.userAgent ?? null,
      }
    }

    const ttl = await this.remainingTtl(sha)
    const now = Date.now()
    const upgraded: ResolvedSession = {
      sub: payload.sub,
      type: payload.type,
      sessionId: payload.sessionId ?? this.idGeneration.next(24),
      createdAt: payload.createdAt ?? now,
      lastSeenAt: payload.lastSeenAt ?? now,
      expiresAt: payload.expiresAt ?? now + ttl * 1000,
      ip: payload.ip ?? null,
      userAgent: payload.userAgent ?? null,
    }

    await this.redis.setJson(sessionKey(sha), upgraded, ttl)
    await this.redis.set(sidKey(upgraded.type, upgraded.sub, upgraded.sessionId), sha, ttl)
    return upgraded
  }
}
