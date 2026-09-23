import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'

/**
 * 运行中的进度（放 Redis，跑完删）。
 *
 * 只放"到哪了"，**不放内容**：内容属于 `timelines`（真相）与输出记录（补发）。
 */
export interface RunProgress {
  status: string
  stage: string
  engineRunId?: string
  streamId?: string
  /** 已写入输出记录的位置（重连从这里接着补发） */
  offset: number
  /** 当前第几步 */
  step: number
  heartbeatAt: string
  updatedAt: string
}

/** 进度键前缀（单键 Hash） */
const progressKey = (runId: string) => `agent:run:${runId}`
/** 输出记录（List，按顺序追加；供断线重连补发） */
const chunksKey = (runId: string) => `agent:stream:${runId}`
/** 跨副本实时转发频道 */
const chunkChannel = (runId: string) => `agent:stream:${runId}:chunk`
/** 跨副本停止信号频道 */
const stopChannel = (runId: string) => `agent:stream:${runId}:stop`

/** 进度键 TTL：6 小时（远大于最长可能的运行时长，进程被 SIGKILL 时靠它自愈） */
const PROGRESS_TTL_SECONDS = 6 * 60 * 60
/** 输出记录 TTL：1 小时（跑完后还能补发一会儿，之后让前端走历史） */
const CHUNKS_TTL_SECONDS = 60 * 60
/** 输出记录最多保留多少条（防止异常情况把内存打满） */
const CHUNKS_MAX = 20_000

/**
 * 运行期状态存储（Redis）：**进度 + 输出记录 + 跨副本广播**。
 *
 * 为什么这三样都在 Redis（设计文档 §3.10）：
 * - 多实例下"连接落在哪个副本"不该改变行为 → 状态一律外置；
 * - 断线重连要能**补发已产出的内容且不重跑** → 输出记录按顺序存着；
 * - 副本 A 在跑、副本 B 持有连接 → 经 pub/sub 把新内容转发给 B。
 *
 * 真相仍在 Postgres（`timelines` / `runs`）；这里的东西**丢了也不影响正确性**，
 * 只会让"实时进度 / 断线补发"降级 —— 所以不需要双写一致性协议。
 */
@Injectable()
export class AgentStreamStore {
  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  // ── 运行中进度 ────────────────────────────────────────────────

  /** 开跑：写进度键（含 TTL） */
  async startRun(runId: string, patch: Partial<RunProgress>): Promise<void> {
    const now = new Date().toISOString()
    const fields: Record<string, string> = {
      status: patch.status ?? 'running',
      stage: patch.stage ?? 'queued',
      offset: String(patch.offset ?? 0),
      step: String(patch.step ?? 0),
      heartbeatAt: patch.heartbeatAt ?? now,
      updatedAt: now,
      ...(patch.engineRunId ? { engineRunId: patch.engineRunId } : {}),
      ...(patch.streamId ? { streamId: patch.streamId } : {}),
    }
    await this.redis.raw.hset(progressKey(runId), fields)
    await this.redis.expire(progressKey(runId), PROGRESS_TTL_SECONDS)
  }

  /** 增量更新进度（调用方按 1s 节流，避免长回复把 Redis 打满） */
  async patchRun(runId: string, patch: Partial<RunProgress>): Promise<void> {
    const fields: Record<string, string> = { updatedAt: new Date().toISOString() }
    if (patch.status) fields.status = patch.status
    if (patch.stage) fields.stage = patch.stage
    if (patch.offset !== undefined) fields.offset = String(patch.offset)
    if (patch.step !== undefined) fields.step = String(patch.step)
    if (patch.heartbeatAt) fields.heartbeatAt = patch.heartbeatAt
    if (patch.streamId !== undefined) fields.streamId = patch.streamId
    await this.redis.raw.hset(progressKey(runId), fields)
  }

  /** 读进度（重连端点判断"是否还有进行中的流"、停止端点找 streamId） */
  async readRun(runId: string): Promise<RunProgress | null> {
    const raw = await this.redis.raw.hgetall(progressKey(runId))
    if (!raw || Object.keys(raw).length === 0) return null
    return {
      status: raw.status ?? 'unknown',
      stage: raw.stage ?? 'unknown',
      engineRunId: raw.engineRunId,
      streamId: raw.streamId,
      offset: Number(raw.offset ?? 0),
      step: Number(raw.step ?? 0),
      heartbeatAt: raw.heartbeatAt ?? '',
      updatedAt: raw.updatedAt ?? '',
    }
  }

  /** 跑完（或失败/取消）：删进度键 —— **先落 Postgres 终态，再删这里**（顺序不可颠倒） */
  async clearRun(runId: string): Promise<void> {
    await this.redis.del(progressKey(runId))
  }

  // ── 输出记录（补发用） ────────────────────────────────────────

  /** 追加一条输出片段，返回它的位置（从 0 开始） */
  async appendChunk(runId: string, chunk: unknown): Promise<number> {
    const key = chunksKey(runId)
    const size = await this.redis.raw.rpush(key, JSON.stringify(chunk))
    // 只留最近 CHUNKS_MAX 条（正常对话远达不到；异常情况防爆）
    if (size > CHUNKS_MAX) await this.redis.raw.ltrim(key, size - CHUNKS_MAX, -1)
    await this.redis.expire(key, CHUNKS_TTL_SECONDS)
    return size - 1
  }

  /** 读 from 及其之后的所有片段（重连补发） */
  async readChunks(runId: string, from: number): Promise<unknown[]> {
    const raw = await this.redis.raw.lrange(chunksKey(runId), Math.max(0, from), -1)
    return raw.map((item) => {
      try {
        return JSON.parse(item) as unknown
      } catch {
        return null
      }
    })
  }

  async clearChunks(runId: string): Promise<void> {
    await this.redis.del(chunksKey(runId))
  }

  // ── 跨副本转发 ────────────────────────────────────────────────

  /** 广播一条片段（持有连接的副本据此转发给自己的客户端） */
  async publishChunk(runId: string, chunk: unknown): Promise<void> {
    await this.redis.raw.publish(chunkChannel(runId), JSON.stringify(chunk))
  }

  /** 广播停止信号（运行在别的副本上时也停得掉） */
  async publishStop(runId: string): Promise<void> {
    await this.redis.raw.publish(stopChannel(runId), 'stop')
  }

  /**
   * 订阅某次运行的实时片段与停止信号。
   *
   * 用一条**独立连接**（ioredis 的订阅连接不能再发普通命令）；
   * 返回取消订阅函数（内部 quit 掉那条连接）。
   */
  async subscribeRun(
    runId: string,
    onChunk: (chunk: unknown) => void,
    onStop: () => void,
  ): Promise<() => Promise<void>> {
    const subscriber = this.redis.raw.duplicate()
    const chunk = chunkChannel(runId)
    const stop = stopChannel(runId)

    subscriber.on('message', (channel, message) => {
      if (channel === chunk) {
        try {
          onChunk(JSON.parse(message) as unknown)
        } catch {
          // 忽略坏帧（不影响主流程）
        }
        return
      }
      if (channel === stop) onStop()
    })

    await subscriber.subscribe(chunk, stop)

    return async () => {
      try {
        await subscriber.unsubscribe(chunk, stop)
      } finally {
        await subscriber.quit()
      }
    }
  }

  /** 打一条 warn（供看门狗/恢复流程复用；保持 logger 只在这里注入一次） */
  warn(event: string, payload: Record<string, unknown>): void {
    this.logger.warn(event, payload)
  }
}
