import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, PubSub, RedisStore } from '@repo/kits'
import {
  AGENT_STREAM_FRAME_VERSION,
  agentStreamChannel,
  type AgentStreamFrameModel,
} from '@repo/shared'

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

/** 进度键前缀（单键 Hash；`clientId` 也放在这里，见 `bindClient`） */
const progressKey = (runId: string) => `agent:run:${runId}`
/** 输出记录（List，按顺序追加；供断线重连补发） */
const chunksKey = (runId: string) => `agent:stream:${runId}`
/** 输出记录字节数（随 list 一起增减，用于字节上限） */
const chunksBytesKey = (runId: string) => `agent:stream:${runId}:bytes`
/** 跨副本停止信号频道 */
const stopChannel = (runId: string) => `agent:stream:${runId}:stop`

/** 进度键 TTL：6 小时（远大于最长可能的运行时长，进程被 SIGKILL 时靠它自愈） */
const PROGRESS_TTL_SECONDS = 6 * 60 * 60
/** 输出记录 TTL：1 小时（跑完后还能补发一会儿，之后让前端走历史） */
const CHUNKS_TTL_SECONDS = 60 * 60
/** 输出记录最多保留多少条（防止异常情况把内存打满） */
const CHUNKS_MAX = 20_000
/** 单 run 输出记录字节上限（防止长回复把 Redis 内存打满；按 UTF-8 字节计） */
const CHUNKS_MAX_BYTES = 32 * 1024 * 1024
/** 一轮结束的片段类型（与 `chat.service` 的 `STREAM_END_MARKER` 同值，避免反向 import） */
const END_MARKER = '__run_end__'

/**
 * 运行期状态存储（Redis）：**进度 + 输出记录 + 跨副本转发**。
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
    @Inject(PubSub) private readonly pubsub: PubSub,
  ) {}

  /**
   * 绑定一次前端连接：把 `clientId`（这条 SSE 连接的收件地址）写进进度 Hash。
   *
   * **必须落 Redis，不能只放进程内 Map**：断线重连可能落在另一个副本上，产 run 的那个副本
   * 读不到新地址就会把实时片段发给已经关掉的老连接（旧实现就是这么丢帧的）。
   */
  async bindClient(runId: string, clientId: string): Promise<void> {
    await this.redis.hset(progressKey(runId), { clientId })
    await this.redis.expire(progressKey(runId), PROGRESS_TTL_SECONDS)
  }

  /** 当前绑定到这条 run 的收件地址（没有绑定 = 没人要实时片段，直接丢） */
  private async clientOf(runId: string): Promise<string | null> {
    const clientId = await this.redis.hget(progressKey(runId), 'clientId')
    return clientId && clientId.trim().length > 0 ? clientId : null
  }

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
    await this.redis.hset(progressKey(runId), fields)
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
    await this.redis.hset(progressKey(runId), fields)
  }

  /** 读进度（重连端点判断"是否还有进行中的流"、停止端点找 streamId） */
  async readRun(runId: string): Promise<RunProgress | null> {
    const raw = await this.redis.hgetall(progressKey(runId))
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
    const payload = JSON.stringify(chunk)
    const bytes = Buffer.byteLength(payload)
    const size = await this.redis.rpush(key, payload)
    await this.redis.expire(key, CHUNKS_TTL_SECONDS)

    const bytesKey = chunksBytesKey(runId)
    const totalBytes = await this.redis.incrBy(bytesKey, bytes)
    await this.redis.expire(bytesKey, CHUNKS_TTL_SECONDS)

    // 双重上限：条数 + 字节。字节超限时从头部弹出并扣减；并发追加同一 run 不常见，
    // 这里的计数是近似值（弹出失败/竞争只会导致提前裁剪，不会超上限）。
    if (size > CHUNKS_MAX) await this.redis.ltrim(key, size - CHUNKS_MAX, -1)
    let overflow = totalBytes - CHUNKS_MAX_BYTES
    if (overflow > 0) {
      let removed = 0
      while (overflow > 0) {
        const popped = await this.redis.lpop(key)
        if (popped === null) break
        const poppedBytes = Buffer.byteLength(popped)
        removed += poppedBytes
        overflow -= poppedBytes
      }
      if (removed > 0) await this.redis.incrBy(bytesKey, -removed)
    }
    return size - 1
  }

  /** 读 from 及其之后的所有片段（重连补发） */
  async readChunks(runId: string, from: number): Promise<unknown[]> {
    const raw = await this.redis.lrange(chunksKey(runId), Math.max(0, from), -1)
    return raw.map((item) => {
      try {
        return JSON.parse(item) as unknown
      } catch {
        return null
      }
    })
  }

  async clearChunks(runId: string): Promise<void> {
    await this.redis.del(chunksKey(runId), chunksBytesKey(runId))
  }

  // ── 跨副本转发 ────────────────────────────────────────────────

  /**
   * 广播一条片段给**持有这条 run 的那个前端连接**。
   *
   * 频道按 `clientId` 定向：只有挂着这条连接的 main 实例收到，其它实例零流量
   * （Kafka 的广播模型是每个副本都收全量、再按 clientId 丢，副本数 N 就放大 N 倍）。
   *
   * `clientId` **每次现读 Redis**，不吃进程内缓存：重连可能落在别的副本上，
   * 缓存一秒就会把这一秒的片段发给已经关掉的连接。代价是每条片段多一次 `HGET`。
   */
  async publishChunk(runId: string, chunk: unknown): Promise<void> {
    const clientId = await this.clientOf(runId)
    if (!clientId) return
    const frame: AgentStreamFrameModel = {
      version: AGENT_STREAM_FRAME_VERSION,
      runId,
      chunk,
      final: (chunk as { type?: unknown })?.type === END_MARKER,
      createdAt: new Date().toISOString(),
    }
    await this.pubsub.broadcast(agentStreamChannel(clientId), frame)
  }

  /**
   * 发布一条**不属于任何 run** 的控制帧（当前只有"排队应答"）。
   *
   * 为什么需要它：main 只把 pub/sub 帧转成前端 SSE，runtime 的 HTTP 响应体是被 drain 掉的。
   * 排队应答发生在**还没建 run** 的时候，没有 runId 可查绑定，只能直接把 `clientId` 递进来。
   */
  async publishControl(input: { clientId: string; runId: string }, chunk: unknown): Promise<void> {
    const frame: AgentStreamFrameModel = {
      version: AGENT_STREAM_FRAME_VERSION,
      runId: input.runId,
      chunk,
      final: false,
      createdAt: new Date().toISOString(),
    }
    const channel = agentStreamChannel(input.clientId)
    await this.pubsub.broadcast(channel, frame)
    // main 的桥只在 `final` 帧上写 `[DONE]`：收尾必须单独再发一帧
    await this.pubsub.broadcast(channel, {
      ...frame,
      chunk: { type: END_MARKER },
      final: true,
    } satisfies AgentStreamFrameModel)
  }

  /** 广播停止信号（运行在别的副本上时也停得掉） */
  async publishStop(runId: string): Promise<void> {
    await this.pubsub.broadcast(stopChannel(runId), { stop: true })
  }

  /**
   * 订阅某次运行的**停止信号**（跨副本）。
   *
   * 只订阅停止、不订阅片段：片段由「跑 run 的那一侧」直接发到前端连接频道，
   * 订阅方再转发会自激（2026-11-15 的 OOM 就是这条回环）。
   */
  async subscribeStop(runId: string, onStop: () => void): Promise<() => void> {
    return this.pubsub.subscribe(stopChannel(runId), () => onStop())
  }

  /** 打一条 warn（供看门狗/恢复流程复用；保持 logger 只在这里注入一次） */
  warn(event: string, payload: Record<string, unknown>): void {
    this.logger.warn(event, payload)
  }
}
