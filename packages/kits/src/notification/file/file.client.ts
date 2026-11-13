import { Inject, Injectable } from '@nestjs/common'
import { AppLogger } from '../../foundation/logger/app-logger.js'
import { mkdir, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { NotifyConfig } from '../notify.config.js'
import type { NotifyClient, NotifyPayload, SendResult } from '../notifier.js'

/**
 * 文件输出通知客户端：把通知内容追加写入文件（默认 `logs/alerts.log`）。
 *
 * **零配置、始终可用**（`configured` 恒为 true）：未配置 lark / email 等真实通道时
 * 作为默认兜底通道，开发 / 演示开箱即用。与其它基础设施模块平级。
 */
@Injectable()
export class FileClient implements NotifyClient {
  readonly channel = 'file' as const

  private readonly filePath: string

  constructor(
    @Inject(NotifyConfig) config: NotifyConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.filePath = config.file?.path ?? 'logs/alerts.log'
  }

  get configured(): boolean {
    return true
  }

  async send(payload: NotifyPayload): Promise<SendResult> {
    if (!('content' in payload)) {
      return { ok: false, error: '文件输出仅支持文本消息（content）' }
    }
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true })
      await appendFile(
        this.filePath,
        `[${new Date().toISOString()}] ${payload.content}\n\n`,
        'utf8',
      )
      return { ok: true }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      this.logger.error('文件通知写入失败', { filePath: this.filePath, error: message })
      return { ok: false, error: message }
    }
  }
}
