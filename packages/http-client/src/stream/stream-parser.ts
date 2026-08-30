import type { StreamMessage } from './types.js'

export interface StreamParseCallbacks {
  /** 完整消息派发（data 为原始字符串） */
  onMessage(message: StreamMessage): void
  /** 收到 retry: 帧（持久生效，直到被下次覆盖） */
  onRetry?(retry: number): void
}

/**
 * 流式 SSE 帧解析器（WHATWG Server-Sent Events 协议）。
 *
 * 特性：
 * - 跨 chunk 边界累积，行以 \n 或 \r\n 分隔，空行结束一条消息
 * - 注释行（: 开头）忽略
 * - data 字段多行以 \n 拼接
 * - 空事件名按 'message' 处理；无 data 的消息不派发
 * - retry 字段持久（不随消息重置），每条消息携带当前值
 */
export class StreamParser {
  private buffer = ''
  private id = ''
  private event = ''
  private data = ''
  private retry: number | undefined

  constructor(private readonly callbacks: StreamParseCallbacks) {}

  /** 喂入一段已解码文本（一个网络 chunk）。 */
  push(text: string): void {
    this.buffer += text
    let lineEnd: number
    while ((lineEnd = this.indexOfLineEnd()) !== -1) {
      let line = this.buffer.slice(0, lineEnd)
      this.buffer = this.buffer.slice(lineEnd + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.processLine(line)
    }
  }

  /** 流结束：清空残余缓冲（SSE 协议以空行结束消息，残余无数据不派发）。 */
  flush(): void {
    this.buffer = ''
  }

  private indexOfLineEnd(): number {
    const newline = this.buffer.indexOf('\n')
    if (newline !== -1) return newline
    return this.buffer.indexOf('\r')
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    // 注释行（: 开头）忽略
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 冒号后的第一个空格按协议忽略
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'id':
        this.id = value
        break
      case 'event':
        this.event = value
        break
      case 'data':
        this.data += (this.data === '' ? '' : '\n') + value
        break
      case 'retry': {
        const ms = Number(value)
        if (!Number.isNaN(ms)) {
          this.retry = ms
          this.callbacks.onRetry?.(ms)
        }
        break
      }
      default:
        // 未知字段忽略（协议允许，为向后兼容）
        break
    }
  }

  private dispatch(): void {
    if (this.data === '') {
      // 无 data 的空消息不派发
      this.reset()
      return
    }
    this.callbacks.onMessage({
      id: this.id,
      event: this.event || 'message',
      data: this.data,
      retry: this.retry,
    })
    this.reset()
  }

  private reset(): void {
    this.id = ''
    this.event = ''
    this.data = ''
    // retry 持久保留（协议语义：重连间隔提示持续生效）
  }
}
