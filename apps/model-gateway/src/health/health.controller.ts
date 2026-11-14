import { Controller, Get, Inject } from '@nestjs/common'
import { Db } from '@repo/kits'
import { ModelCatalogService } from '../catalog/model.catalog.service.js'

/**
 * 运维探针。
 *
 * - `/healthz`：只探进程（liveness 不探依赖，避免依赖抖动引发全量重启）；
 * - `/readyz`：探 PG + 模型目录是否可读（**不探供应商**，见设计稿 §9）。
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(ModelCatalogService) private readonly catalog: ModelCatalogService,
  ) {}

  @Get('healthz')
  healthz(): { status: string } {
    return { status: 'ok' }
  }

  @Get('readyz')
  async readyz(): Promise<{ status: string; db: boolean; models: number }> {
    const db = await this.db.dataSource
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false)
    const models = db ? await this.catalog.count().catch(() => 0) : 0
    return { status: db ? 'ok' : 'degraded', db, models }
  }
}
