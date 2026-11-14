import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, StreamHub } from '@repo/kits'
import {
  STREAM_ADMIN_BROADCAST_CHANNEL,
  STREAM_ALERT_FIRED_EVENT,
  type AlertFiredEventModel,
} from '@repo/shared'

/** 告警实时推送：只负责 SSE，不参与发送与落库 */
@Injectable()
export class AlertStreamService {
  constructor(
    @Inject(StreamHub) private readonly streamHub: StreamHub,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  publish(payload: AlertFiredEventModel): void {
    try {
      this.streamHub.publish(STREAM_ADMIN_BROADCAST_CHANNEL, {
        event: STREAM_ALERT_FIRED_EVENT,
        data: payload,
      })
    } catch (error) {
      this.logger.warn('告警实时推送失败', { error })
    }
  }
}
