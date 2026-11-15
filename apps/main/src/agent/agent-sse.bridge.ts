import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, PubSub } from '@repo/kits'
import {
  AgentStreamFrameSchema,
  agentStreamChannel,
  type AgentStreamFrameModel,
} from '@repo/shared'
import type { Response } from 'express'

interface Session {
  clientId: string
  res: Response
  closed: boolean
  /** 还没发响应头：帧先攒着，`start()` 后按序补出 */
  deferred: boolean
  backlog: AgentStreamFrameModel[]
  /** 退订函数（`subscribeAsync` 返回；连接关闭时调用） */
  unsubscribe: (() => void) | null
}

/**
 * main 侧的 **pub/sub → SSE** 桥。
 *
 * 频道按 `clientId` 定向（`agent:stream:client:<clientId>`）：runtime 把每一段输出发到
 * 挂着这条连接的那个 main 实例上，其它副本零流量。main 不解析模型内容，只做传输。
 *
 * 为什么不再是 Kafka：这条链路不需要积压、回放或多消费方 —— 补发靠 runtime 的 Redis 输出
 * 记录按 offset 读；Kafka 只会给每个副本都灌全量事件（2026-11-15 实测 686MB / 1.5M 条）。
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
   * 一小段里发出来的帧会丢（首帧 `start` / `data-run` 丢了前端整轮渲染都会错）。
   */
  async attach(clientId: string, res: Response, deferred = false): Promise<void> {
    const session: Session = {
      clientId,
      res,
      closed: false,
      deferred,
      backlog: [],
      unsubscribe: null,
    }
    this.sessions.set(clientId, session)
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
        unsubscribe()
        return
      }
      session.unsubscribe = unsubscribe
    } catch (error) {
      this.logger.warn('agent.sse.subscribe_failed', {
        clientId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  detach(clientId: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    this.sessions.delete(clientId)
    session.unsubscribe?.()
    session.unsubscribe = null
  }

  /** 响应头已发出（补发完成）：把 deferred 期间攒下的帧按序补出 */
  start(clientId: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    session.deferred = false
    for (const frame of session.backlog.splice(0)) this.deliver(session, frame)
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
      if (frame.final) {
        session.res.write('data: [DONE]\n\n')
        session.res.end()
        session.closed = true
        this.detach(session.clientId)
        return
      }
      session.res.write(`data: ${JSON.stringify(frame.chunk)}\n\n`)
    } catch {
      session.closed = true
      this.detach(session.clientId)
    }
  }
}
