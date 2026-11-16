import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, PubSub, RedisStore } from '@repo/kits'
import {
  AGENT_STREAM_FRAME_VERSION,
  agentStreamChannel,
  encodeAgUiChunk,
  isRunFinalEvent,
  type AgentStreamFrameModel,
  type AgUiChunk,
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
  /** 已写入输出记录的最新 **rev**（单调递增；重连从这里接着补发） */
  rev: number
  /** 当前第几步 */
  step: number
  heartbeatAt: string
  updatedAt: string
}

/** 输出记录里的一条（事件 + 它的单调 rev） */
export interface StreamRecord {
  rev: number
  event: unknown
}

/** 进度键前缀（单键 Hash；`clientId` 也放在这里，见 `bindClient`） */
const progressKey = (runId: string) => `agent:run:${runId}`
/** 输出记录（List，按顺序追加；供断线重连补发） */
const chunksKey = (runId: string) => `agent:stream:${runId}`
/** 输出记录字节数（随 list 一起增减，用于字节上限） */
const chunksBytesKey = (runId: string) => `agent:stream:${runId}:bytes`
/**
 * 输出记录的单调序号（`INCR`）。
 *
 * 为什么不用 List 下标：记录有上限（20k 帧 / 32MB），`ltrim` / `lpop` 会从头部裁剪，
 * 下标整体前移 —— 拿下标当水位，裁剪一次就漂移（手册 §0.2）。rev 只增不减，与裁剪解耦。
 */
const revKey = (runId: string) => `agent:stream:${runId}:rev`
/** 跨副本停止信号频道 */
const stopChannel = (runId: string) => `agent:stream:${runId}:stop`
/**
 * 补发闸门（跨副本）：计数 > 0 时，产事件的一侧要等补发完成再写。
 *
 * 为什么需要：补发与实时事件走同一条定向频道；补发是一批 pipeline，Redis 逐条处理，
 * 实时 PUBLISH 可能插到这批中间 → 前端看到乱序。闸门让实时侧**不放行**，靠 TTL 自愈。
 */
const replayKey = (runId: string) => `agent:stream:${runId}:replay`
/** 闸门 TTL：补发进程被杀时靠它自愈（正常补发是几十毫秒） */
const REPLAY_GATE_TTL_SECONDS = 30

/** 进度键 TTL：6 小时（远大于最长可能的运行时长，进程被 SIGKILL 时靠它自愈） */
const PROGRESS_TTL_SECONDS = 6 * 60 * 60
/** 输出记录 TTL：1 小时（跑完后还能补发一会儿，之后让前端走历史） */
const CHUNKS_TTL_SECONDS = 60 * 60
/** 输出记录最多保留多少条（防止异常情况把内存打满） */
const CHUNKS_MAX = 20_000
/** 单 run 输出记录字节上限（防止长回复把 Redis 内存打满；按 UTF-8 字节计） */
const CHUNKS_MAX_BYTES = 32 * 1024 * 1024
/**
 * 补发闸门最长等待：**TTL + 余量**。
 *
 * 正常情况下等不到这个数（键到期会被 Redis 删掉）；这是"TTL 没生效"时的最后一道保险，
 * 不是常规出口 —— 常规出口只有"闸门键消失"。
 */
const REPLAY_GATE_MAX_WAIT_MS = (REPLAY_GATE_TTL_SECONDS + 5) * 1000

/** 闸门轮询退避：10ms → 100ms 封顶（闸门活跃时别把生成侧压成每秒上百次 EXISTS） */
const replayPollDelay = (attempt: number): number => Math.min(10 * 2 ** Math.min(attempt, 4), 100)

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
   * 读不到新地址就会把实时事件发给已经关掉的老连接（旧实现就是这么丢帧的）。
   */
  async bindClient(runId: string, clientId: string): Promise<void> {
    await this.redis.hset(progressKey(runId), { clientId })
    await this.redis.expire(progressKey(runId), PROGRESS_TTL_SECONDS)
  }

  /** 当前绑定到这条 run 的收件地址（没有绑定 = 没人要实时事件，直接丢） */
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
      rev: String(patch.rev ?? 0),
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
    if (patch.rev !== undefined) fields.rev = String(patch.rev)
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
      rev: Number(raw.rev ?? 0),
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

  /**
   * 追加一个事件，返回它的单调 rev。
   *
   * 记录形状 `{ rev, event }`：补发按 rev 切片，不再受 List 裁剪影响。
   * 双上限（条数 20k + 字节 32MB）超了从头部裁剪，rev 不受影响。
   */
  async appendEvent(runId: string, event: unknown): Promise<number> {
    const key = chunksKey(runId)
    const rev = await this.redis.incr(revKey(runId))
    const payload = JSON.stringify({ rev, event })
    const bytes = Buffer.byteLength(payload)
    const size = await this.redis.rpush(key, payload)
    await this.redis.expire(key, CHUNKS_TTL_SECONDS)
    await this.redis.expire(revKey(runId), CHUNKS_TTL_SECONDS)

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
    return rev
  }

  /**
   * 读 `fromRev`（含）之后的所有记录。
   *
   * 用「首条记录的 rev → 下标」直接定位，不拉全量：补发窗口可能只有几十帧，
   * 没必要为它读 20k 条（手册实测 1.5MB / 15,657 帧）。
   */
  async readEvents(runId: string, fromRev: number): Promise<StreamRecord[]> {
    const key = chunksKey(runId)
    const first = await this.redis.lindex(key, 0)
    if (first === null) return []
    const firstRev = revOf(first, 0)
    const start = Math.max(0, Math.floor(fromRev) - firstRev)
    const raw = await this.redis.lrange(key, start, -1)
    const out: StreamRecord[] = []
    raw.forEach((item, index) => {
      const record = parseRecord(item, start + index)
      if (!record) return
      if (record.rev >= fromRev) out.push(record)
    })
    return out
  }

  /** 读全部记录（快照归约用；上限 20k 条） */
  async readAllEvents(runId: string): Promise<StreamRecord[]> {
    return this.readEvents(runId, 0)
  }

  async clearEvents(runId: string): Promise<void> {
    await this.redis.del(chunksKey(runId), chunksBytesKey(runId), revKey(runId))
  }

  // ── 补发闸门 ──────────────────────────────────────────────────

  /**
   * 合闸门（在**读输出记录之前**调用）。
   *
   * 用计数而不是布尔：同一 run 可能并发重连两次，先结束的那个不能把闸门提前拆掉。
   */
  async beginReplay(runId: string): Promise<void> {
    try {
      await this.redis.incr(replayKey(runId))
      await this.redis.expire(replayKey(runId), REPLAY_GATE_TTL_SECONDS)
    } catch (error) {
      // 闸门是"防乱序"的增强，不是补发的前置条件：Redis 抖动时照常补发
      this.warn('ai.stream.replay_gate_failed', {
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 补发完成：计数归零时拆闸门；> 0 说明还有另一个补发在跑 */
  async endReplay(runId: string): Promise<void> {
    try {
      const left = await this.redis.incrBy(replayKey(runId), -1)
      if (left <= 0) await this.redis.del(replayKey(runId))
    } catch (error) {
      this.warn('ai.stream.replay_gate_release_failed', {
        runId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 产事件前等闸门放开（**不放行**策略）。
   *
   * 为什么不在 `publishEvent` 里等：事件此时已经 `appendEvent` 进了记录，
   * 补发可能把它读进去 —— 等完再发就会重复。等在 append 之前，记录是稳定的。
   *
   * **TTL 是唯一出口**：闸门键带 `REPLAY_GATE_TTL_SECONDS` 过期，所以"补发方进程被杀"这种
   * 情况会由 Redis 自己把键清掉，等待方最多等一个 TTL。这里**不设"超时就放行"** ——
   * 那正是乱序的根因：生成侧放行时补发还没读完记录，同一段内容两边都发。
   *
   * 兜底保护：如果 TTL 因为 Redis 原因没生效（键一直在），最多等 `REPLAY_GATE_MAX_WAIT_MS`
   * 就放行并记一条 error 级日志 —— 宁可留一条可排查的告警，也不无限期卡住生成。
   * 轮询用退避（10 → 100ms）：闸门活跃期间每条事件只多做几次 `EXISTS`，不再固定 100 次/秒。
   */
  async waitForReplayGate(runId: string): Promise<void> {
    const startedAt = Date.now()
    for (let attempt = 0; ; attempt += 1) {
      let exists = 0
      try {
        exists = await this.redis.exists(replayKey(runId))
      } catch {
        // 读不到闸门就放行：不能因为一次 Redis 抖动把生成卡死
        return
      }
      if (exists === 0) return
      const waited = Date.now() - startedAt
      if (waited >= REPLAY_GATE_MAX_WAIT_MS) {
        this.warn('ai.stream.replay_gate_stuck', {
          runId,
          waitedMs: waited,
          reason: '闸门键超过 TTL 仍未释放（Redis 过期未生效？），放行以免卡死生成',
        })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, replayPollDelay(attempt)))
    }
  }

  // ── 跨副本转发 ────────────────────────────────────────────────

  /**
   * 广播一个事件给**持有这条 run 的那个前端连接**。
   *
   * 频道按 `clientId` 定向：只有挂着这条连接的 main 实例收到，其它实例零流量
   * （Kafka 的广播模型是每个副本都收全量、再按 clientId 丢，副本数 N 就放大 N 倍）。
   *
   * `clientId` **每次现读 Redis**，不吃进程内缓存：重连可能落在别的副本上，
   * 缓存一秒就会把这一秒的事件发给已经关掉的连接。代价是每个事件多一次 `HGET`。
   */
  async publishEvent(runId: string, event: unknown): Promise<void> {
    const clientId = await this.clientOf(runId)
    if (!clientId) return
    await this.pubsub.broadcast(agentStreamChannel(clientId), this.frameOf(runId, event))
  }

  /**
   * 批量补发（一次 pipeline）。
   *
   * 逐条 `await publish` 时 1.5 万帧约 3 秒，这期间实时帧会插到补发中间；
   * 批量后实测 ~56ms（手册附录 A）。
   */
  async publishEvents(runId: string, events: readonly unknown[]): Promise<number> {
    if (events.length === 0) return 0
    const clientId = await this.clientOf(runId)
    if (!clientId) return 0
    return this.pubsub.broadcastMany(
      agentStreamChannel(clientId),
      events.map((event) => this.frameOf(runId, event)),
    )
  }

  /**
   * 发布一条**不属于任何 run** 的控制帧（当前只有"排队应答"）。
   *
   * 为什么需要它：main 只把 pub/sub 帧转成前端 SSE，runtime 的 HTTP 响应体是被 drain 掉的。
   * 排队应答发生在**还没建 run** 的时候，没有 runId 可查绑定，只能直接把 `clientId` 递进来。
   */
  async publishControl(
    input: { clientId: string; runId: string; conversationId?: string },
    chunk: unknown,
  ): Promise<void> {
    const threadId = input.conversationId ?? ''
    const events = encodeAgUiChunk(chunk as AgUiChunk, {
      threadId,
      runId: input.runId,
    })
    const channel = agentStreamChannel(input.clientId)
    await this.pubsub.broadcastMany(
      channel,
      events.map((event) => this.frameOf(input.runId, event)),
    )
    // 应答本身也要收尾（main 只在 final 帧上 end；不补这一帧，POST 连接会一直挂着）
    await this.pubsub.broadcastMany(channel, [
      this.frameOf(input.runId, {
        type: 'RUN_FINISHED',
        threadId,
        runId: input.runId,
        timestamp: Date.now(),
      }),
    ])
  }

  /** 广播停止信号（运行在别的副本上时也停得掉） */
  async publishStop(runId: string): Promise<void> {
    await this.pubsub.broadcast(stopChannel(runId), { stop: true })
  }

  /**
   * 订阅某次运行的**停止信号**（跨副本）。
   *
   * 只订阅停止、不订阅事件：事件由「跑 run 的那一侧」直接发到前端连接频道，
   * 订阅方再转发会自激（2026-11-15 的 OOM 就是这条回环）。
   */
  async subscribeStop(runId: string, onStop: () => void): Promise<() => void> {
    return this.pubsub.subscribe(stopChannel(runId), () => onStop())
  }

  /** 打一条 warn（供看门狗/恢复流程复用；保持 logger 只在这里注入一次） */
  warn(event: string, payload: Record<string, unknown>): void {
    this.logger.warn(event, payload)
  }

  /** 统一的帧信封（`final` 只看事件本身，不依赖旧结束标记） */
  private frameOf(runId: string, event: unknown): AgentStreamFrameModel {
    return {
      version: AGENT_STREAM_FRAME_VERSION,
      runId,
      event,
      final: isRunFinalEvent(event),
      createdAt: new Date().toISOString(),
    }
  }
}

/** 记录里取出 rev（旧记录可能只有 `{rev, chunk}` 或裸 chunk） */
const revOf = (raw: string, index: number): number => {
  try {
    const parsed = JSON.parse(raw) as { rev?: unknown }
    return typeof parsed?.rev === 'number' ? parsed.rev : index + 1
  } catch {
    return index + 1
  }
}

/**
 * 归一成 `{ rev, event }`。
 *
 * 新记录 `{rev,event}`；旧记录 `{rev,chunk}` 或裸 chunk（TTL 内自然过期，不写迁移脚本）。
 * 读侧兼容是升级瞬间不崩的唯一保证（手册 §8 坑 5）。
 */
const parseRecord = (raw: string, index: number): StreamRecord | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as { rev?: unknown; event?: unknown; chunk?: unknown }
    if (typeof record.rev === 'number') {
      return {
        rev: record.rev,
        event: 'event' in record ? record.event : record.chunk,
      }
    }
  }
  return { rev: index + 1, event: parsed }
}
