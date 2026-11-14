import { Controller, Get, Inject, UseFilters, UseGuards, UseInterceptors } from '@nestjs/common'
import type { GatewayCatalog } from '@repo/contracts'
import { AppExceptionFilter, ResponseEnvelopeInterceptor } from '@repo/kits'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { ModelCatalogService } from './model.catalog.service.js'

/** 内部目录：runtime 的运行期模型解析（不含密钥 / 上游地址） */
@Controller('internal')
@UseGuards(InternalTokenGuard)
@UseFilters(AppExceptionFilter)
@UseInterceptors(ResponseEnvelopeInterceptor)
export class CatalogController {
  constructor(@Inject(ModelCatalogService) private readonly catalog: ModelCatalogService) {}

  @Get('catalog')
  list(): Promise<GatewayCatalog> {
    return this.catalog.catalog()
  }
}
