import { Inject, Injectable } from '@nestjs/common'
import type {
  GetMonitorAlertDetailDto,
  MonitorAlertDetailModel,
  MonitorAlertModel,
  PageQueryMonitorAlertDto,
  PageQueryMonitorLogDto,
} from '@repo/shared'
import type { PageQueryResult } from '@repo/kits'
import { AlertRepository } from '../engine/alert.repository.js'
import { AlertLogRepository } from '../engine/alert-log.repository.js'
import { MonitorAlertNotFoundError } from '../errors.js'

/** 告警记录读模型 */
@Injectable()
export class MonitorAlertService {
  constructor(
    @Inject(AlertRepository) private readonly alerts: AlertRepository,
    @Inject(AlertLogRepository) private readonly logs: AlertLogRepository,
  ) {}

  page(query: PageQueryMonitorAlertDto): Promise<PageQueryResult<MonitorAlertModel>> {
    return this.alerts.page(query)
  }

  logsPage(query: PageQueryMonitorLogDto) {
    return this.logs.page(query)
  }

  async detail(input: GetMonitorAlertDetailDto): Promise<MonitorAlertDetailModel> {
    const alert = await this.alerts.findModelById(input.alertId)
    if (!alert) throw new MonitorAlertNotFoundError(input.alertId)
    return {
      alert,
      deliveries: await this.logs.listByAlertId(input.alertId),
    }
  }
}
