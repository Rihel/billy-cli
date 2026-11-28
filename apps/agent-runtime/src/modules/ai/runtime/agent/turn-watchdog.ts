import type { RunRepository } from '../run/run.repository.js'

/** 心跳间隔（SSE 注释帧 + DB 租约续期） */
export const STREAM_HEARTBEAT_MS = 15_000

export interface TurnWatchdogOptions {
  runs: RunRepository
  runId: string
  /** 首 token 超时（ms；0 = 关闭） */
  firstTokenTimeoutMs: number
  /** 心跳一次之后的可选动作（流式路径写 SSE 注释帧；无头路径不传） */
  onHeartbeat?: () => void
  /** 首段输出到达（算首 token 耗时；传了才记） */
  onFirstToken?: (elapsedMs: number) => void
  /** 这一轮的起点（算首 token 耗时） */
  startedAt?: number
  /** 首 token 超时：由调用方 abort 这一轮（Mastra 收到 abort 后会正常返回） */
  onTimeout?: () => void
}

/**
 * 一轮执行的看护：心跳续租 + 首 token 超时。
 *
 * 抽出来的原因：三条执行路径（首轮 / 续跑 / 无头队列）各写了一遍完全相同的定时器与
 * 标记位，早先修改「心跳先续租再写 ping」时漏了一处就复发过。
 *
 * 语义保持：
 * - 心跳**先续租再写 ping**（写 ping 失败只说明连接没了，不能把进程带走）；
 * - 首 token 超时走同一个 abort，但用独立标记区分「超时失败」与「用户取消」；
 * - 收到第一段输出（文本 / 推理 / 工具入参）就撤掉看护，只撤一次。
 */
export class TurnWatchdog {
  private heartbeat?: NodeJS.Timeout
  private firstTokenTimer?: NodeJS.Timeout
  private firstTokenTimedOut = false
  private firstTokenSeen = false
  private readonly startedAt: number

  constructor(private readonly options: TurnWatchdogOptions) {
    this.startedAt = options.startedAt ?? Date.now()
  }

  /** 是否因首 token 超时而中止（收尾分支据此判 3314，而不是用户取消） */
  get timedOut(): boolean {
    return this.firstTokenTimedOut
  }

  /** 起心跳（幂等）：续租 + 可选写注释帧 */
  startHeartbeat(): void {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      // ① 先续租：即使客户端已经断开，这一轮仍然有人在管（生成还在继续，可重连续看）
      void this.options.runs.touchHeartbeat(this.options.runId).catch(() => undefined)
      // ② 再 best-effort 写注释帧：写失败只说明连接没了，不能把进程带走
      this.options.onHeartbeat?.()
    }, STREAM_HEARTBEAT_MS)
    this.heartbeat.unref?.()
  }

  /** 从发起模型调用开始计时（0 = 关闭） */
  armFirstToken(): void {
    const timeoutMs = this.options.firstTokenTimeoutMs
    if (!timeoutMs || this.firstTokenTimer || this.firstTokenSeen) return
    this.firstTokenTimer = setTimeout(() => {
      this.firstTokenTimedOut = true
      // 走同一个 abort：Mastra 收流后会正常返回，收尾分支按"超时失败"处理
      this.options.onTimeout?.()
    }, timeoutMs)
    this.firstTokenTimer.unref?.()
  }

  /** 收到第一段输出（文本 / 推理 / 工具入参）就撤掉看护 */
  markFirstTokenSeen(): void {
    if (this.firstTokenSeen) return
    this.firstTokenSeen = true
    this.stopFirstTokenTimer()
    this.options.onFirstToken?.(Date.now() - this.startedAt)
  }

  /** 停掉心跳与首 token 定时器（幂等；收尾 finally 调用） */
  stop(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    this.stopFirstTokenTimer()
  }

  private stopFirstTokenTimer(): void {
    if (!this.firstTokenTimer) return
    clearTimeout(this.firstTokenTimer)
    this.firstTokenTimer = undefined
  }
}
