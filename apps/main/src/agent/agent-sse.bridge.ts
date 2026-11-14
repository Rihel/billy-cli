import { Injectable } from '@nestjs/common'
import { KafkaConsumer } from '@repo/kits'
import { AGENT_RUN_EVENT_TOPIC, AgentRunEventSchema, type AgentRunEventModel } from '@repo/shared'
import type { Response } from 'express'

interface Session {
  res: Response
  closed: boolean
  deferred: boolean
  backlog: AgentRunEventModel[]
}

/** 每个 main 实例独立消费组：Kafka 广播给所有实例，各实例只推自己的 clientId */
const SSE_GROUP = `main-sse-${process.env.POD_NAME ?? process.env.HOSTNAME ?? process.pid}`

/**
 * main 侧的 Kafka → SSE 桥。
 *
 * runtime 把每一段输出发到 `agent.run.events`；这里按 `clientId` 找到前端连接，
 * 原样写成 AI SDK UI Message Stream 的 `data:` 帧。main 不解析模型内容，只做传输。
 */
@Injectable()
export class AgentSseBridge {
  private readonly sessions = new Map<string, Session>()

  detach(clientId: string): void {
    this.sessions.delete(clientId)
  }

  attach(clientId: string, res: Response, deferred = false): void {
    const session: Session = { res, closed: false, deferred, backlog: [] }
    this.sessions.set(clientId, session)
    res.on('close', () => {
      session.closed = true
      this.sessions.delete(clientId)
    })
  }

  @KafkaConsumer(AGENT_RUN_EVENT_TOPIC, SSE_GROUP)
  onEvent(payload: unknown): void {
    const parsed = AgentRunEventSchema.safeParse(payload)
    if (!parsed.success) return
    const event = parsed.data
    const session = this.sessions.get(event.clientId)
    // 每个 main 实例都会收到全量事件；没有本实例连接的直接丢弃，避免 pending 无界增长
    if (!session) return
    this.deliver(event.clientId, session, event)
  }

  start(clientId: string): void {
    const session = this.sessions.get(clientId)
    if (!session) return
    session.deferred = false
    const backlog = session.backlog.splice(0)
    for (const event of backlog) this.deliver(clientId, session, event)
  }

  private deliver(clientId: string, session: Session, event: AgentRunEventModel): void {
    if (session.closed || session.res.writableEnded) return
    if (session.deferred) {
      session.backlog.push(event)
      if (session.backlog.length > 1000) session.backlog.shift()
      return
    }
    try {
      if (event.final) {
        session.res.write('data: [DONE]\n\n')
        session.res.end()
        session.closed = true
        this.sessions.delete(clientId)
        return
      }
      session.res.write(`data: ${JSON.stringify(event.chunk)}\n\n`)
    } catch {
      session.closed = true
      this.sessions.delete(clientId)
    }
  }
}
