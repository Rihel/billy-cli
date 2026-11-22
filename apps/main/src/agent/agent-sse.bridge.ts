import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, PubSub } from '@repo/kits'
import {
  AgentStreamFrameSchema,
  agUiEventToChunks,
  agentStreamChannel,
  createAgUiDecodeState,
  encodeAgUiChunk,
  isAgUiEvent,
  isRunFinalEvent,
  type AgentStreamFrameModel,
  type AgUiChunk,
  type AgUiDecodeState,
} from '@repo/shared'
import type { Response } from 'express'

/** 出口协议：`agui` 默认透传事件，`ai` 逆映射回旧 chunk（灰度与止血用） */
export type StreamProtocol = 'agui' | 'ai'

/**
 * 空闲心跳间隔（毫秒）。
 *
 * 为什么必须补：这条流真的会分钟级静默 —— 一次 `bash` 最长 5 分钟、推理型模型首 token 前
 * 可能长时间不吐字、排队等 runtime 开跑也一个字节都没有。手机网络 / 公司代理 / CDN 普遍
 * 在 30~120s 空闲就断连，断了不会丢数据（快照 + `sinceRev` 能续），但用户要经历一次
 * 「重连 → 拉快照 → 补发」，运行中灯还会闪一下。
 *
 * 15s 与 `/sse/subscribe` 那条链路（`StreamConnection` 默认 15000）保持同一口径，且显著
 * 小于 ingress-nginx 的 60s 上游空闲超时。
 */
const SSE_HEARTBEAT_MS = 15_000

/** 心跳注释帧（WHATWG SSE 规范里的注释行；`parseAgUiSse` 明确跳过非 `data:` 帧） */
const HEARTBEAT_FRAME = ': ping\n\n'

interface Session {
  clientId: string
  res: Response
  closed: boolean
  /** 还没发响应头：帧先攒着，`start()` 后按序补出 */
  deferred: boolean
  backlog: AgentStreamFrameModel[]
  /** 退订函数（`subscribeAsync` 返回；连接关闭时调用） */
  unsubscribe: (() => void) | null
  protocol: StreamProtocol
  /** 回退口的解码状态要贯穿整条连接（工具入参才能跨 ARGS 累积） */
  decode: AgUiDecodeState
  /** 最近一次向这条连接写字节的时间（心跳据此只在空闲时补） */
  lastWriteAt: number
  /** 空闲心跳定时器（`detach` / `fail` 必须清掉，否则连接关了还在往死 socket 写） */
  heartbeat: NodeJS.Timeout | null
}

/** 出口协议解析：只认 `ai`，其余一律按默认的 `agui` */
export const parseStreamProtocol = (value: unknown): StreamProtocol =>
  value === 'ai' ? 'ai' : 'agui'

/**
 * main 侧的 **pub/sub → SSE** 桥。
 *
 * 频道按 `clientId` 定向（`agent:stream:client:<clientId>`）：runtime 把每一段输出发到
 * 挂着这条连接的那个 main 实例上，其它副本零流量。main 不解析模型内容，只做传输。
 *
 * 出口两种协议：
 * - `agui`（默认）：原样透传事件；收尾是 `RUN_FINISHED` + `end()`，**不写 `[DONE]`** ——
 *   官方客户端会对 `[DONE]` 做 `JSON.parse`，抛错后整条流被 error 掉（手册 §8 坑 1）；
 * - `ai`（回退）：事件逆映射回旧 chunk，收尾仍写 `[DONE]`，老前端零改动。
 */
@Injectable()
export class AgentSseBridge {
  private readonly sessions = new Map<string, Session>()

  constructor(
    @Inject(PubSub) private readonly pubsub: PubSub,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /**
   * 挂上一条前端连接并**等订阅生效**再返回。
   *
   * 必须等：调用方接下来就触发 runtime 开跑，而 `PubSub.subscribe` 是后台建连 —— 中间那
   * 一小段里发出来的帧会丢（首帧 `RUN_STARTED` 丢了前端整轮渲染都会错）。
   */
  async attach(
    clientId: string,
    res: Response,
    options: { deferred?: boolean; protocol?: StreamProtocol } = {},
  ): Promise<boolean> {
    const session: Session = {
      clientId,
      res,
      closed: false,
      deferred: options.deferred ?? false,
      backlog: [],
      unsubscribe: null,
      protocol: options.protocol ?? 'agui',
      decode: createAgUiDecodeState(),
      lastWriteAt: Date.now(),
      heartbeat: null,
    }
    this.sessions.set(clientId, session)
    // 从建连接就开始心跳：排队等 runtime 开跑、模型首 token 前的长时间静默都靠它保活
    session.heartbeat = setInterval(() => this.beat(session), SSE_HEARTBEAT_MS)
    session.heartbeat.unref?.()
    res.on('close', () => {
      session.closed = true
      this.detach(clientId)
    })
    try {
      const unsubscribe = await this.pubsub.subscribeAsync(
        agentStreamChannel(clientId),
        (payload) => this.onFrame(session, payload),
      )
      // 订阅 await 期间连接可能已经关了 / 被替换：别把订阅漏在后台
      if (session.closed || this.sessions.get(clientId) !== session) {
        this.clearHeartbeat(session)
        unsubscribe()
        return false
      }
      session.unsubscribe = unsubscribe
      return true
    } catch (error) {
      this.logger.warn('agent.sse.subscribe_failed', {
        clientId,
        reason: error instanceof Error ? error.message : String(error),
      })
      // 订阅没成功就不能让调用方继续触发 runtime：否则这一轮所有帧都发到没人收的频道，
      // 连接又被心跳保活，前端会一直停在"思考中"。
      this.clearHeartbeat(session)
      return false
    }
  }

  detach(clientId: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    this.sessions.delete(clientId)
    this.clearHeartbeat(session)
    session.unsubscribe?.()
    session.unsubscribe = null
  }

  private clearHeartbeat(session: Session): void {
    if (!session.heartbeat) return
    clearInterval(session.heartbeat)
    session.heartbeat = null
  }

  /**
   * 空闲心跳：距上次写过帧不足一个间隔就跳过 —— 有输出时不需要额外噪声，
   * 心跳只负责"长时间没有字节"的那一段。
   */
  private beat(session: Session): void {
    if (session.closed || session.deferred || session.res.writableEnded) return
    if (Date.now() - session.lastWriteAt < SSE_HEARTBEAT_MS) return
    try {
      session.res.write(HEARTBEAT_FRAME)
      session.lastWriteAt = Date.now()
    } catch {
      // 写失败说明连接已经没了（客户端刷新 / 换网络）：收掉这条 session
      session.closed = true
      this.detach(session.clientId)
    }
  }

  /** 响应头已发出（补发完成）：把 deferred 期间攒下的帧按序补出 */
  start(clientId: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    session.deferred = false
    for (const frame of session.backlog.splice(0)) this.deliver(session, frame)
  }

  /** 错误路径也要分协议：agui 写 `RUN_ERROR` + `RUN_FINISHED`；ai 写 error + `[DONE]` */
  fail(clientId: string, message: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    if (session.res.writableEnded) {
      this.detach(clientId)
      return
    }
    if (session.protocol === 'ai') {
      session.res.write(`data: ${JSON.stringify({ type: 'error', errorText: message })}\n\n`)
      session.res.write('data: [DONE]\n\n')
    } else {
      session.res.write(
        `data: ${JSON.stringify({ type: 'RUN_ERROR', message, timestamp: Date.now() })}\n\n`,
      )
      session.res.write(
        `data: ${JSON.stringify({
          type: 'RUN_FINISHED',
          threadId: '',
          runId: '',
          timestamp: Date.now(),
        })}\n\n`,
      )
    }
    session.closed = true
    session.res.end()
    this.detach(clientId)
  }

  private onFrame(session: Session, payload: unknown): void {
    const parsed = AgentStreamFrameSchema.safeParse(payload)
    if (!parsed.success) return
    const frame = parsed.data
    if (session.deferred) {
      session.backlog.push(frame)
      // 上限兜底：正常补发是毫秒级，堆到这里说明对端卡住了
      if (session.backlog.length > 1000) session.backlog.shift()
      return
    }
    this.deliver(session, frame)
  }

  private deliver(session: Session, frame: AgentStreamFrameModel): void {
    if (session.closed || session.res.writableEnded) {
      this.detach(session.clientId)
      return
    }
    try {
      if (session.protocol === 'ai') {
        // 回退口：事件 → 旧 chunk（状态贯穿整条连接，工具入参才能累积）
        for (const chunk of this.chunksOf(session, frame.event)) {
          session.res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }
        session.lastWriteAt = Date.now()
        if (frame.final || isRunFinalEvent(frame.event)) {
          session.res.write('data: [DONE]\n\n')
          session.res.end()
          session.closed = true
          this.detach(session.clientId)
        }
        return
      }

      // 默认：AG-UI 原样透传（旧记录是裸 chunk 的，才现场编一下）
      for (const event of this.eventsOf(session, frame.event)) {
        session.res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      session.lastWriteAt = Date.now()
      if (frame.final || isRunFinalEvent(frame.event)) {
        // 关键：**不写 `[DONE]`**，AG-UI 的收尾就是 RUN_FINISHED，写完直接 end
        session.res.end()
        session.closed = true
        this.detach(session.clientId)
      }
    } catch {
      session.closed = true
      this.detach(session.clientId)
    }
  }

  /** 帧载荷 → 事件：新记录就是事件，旧记录（裸 chunk）才现场编 */
  private eventsOf(session: Session, payload: unknown): unknown[] {
    if (isAgUiEvent(payload)) return [payload]
    return encodeAgUiChunk(payload as AgUiChunk, { threadId: '', runId: '' })
  }

  /** 帧载荷 → 旧 chunk（回退口；`session.decode` 贯穿整条连接） */
  private chunksOf(session: Session, payload: unknown): unknown[] {
    return isAgUiEvent(payload) ? agUiEventToChunks(payload, session.decode) : [payload]
  }
}
