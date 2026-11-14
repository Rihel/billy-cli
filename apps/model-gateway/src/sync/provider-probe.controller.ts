import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common'
import {
  ProviderListModelsRequestSchema,
  ProviderProbeRequestSchema,
  type ProviderListModelsRequest,
  type ProviderProbeRequest,
} from '@repo/contracts'
import { AppExceptionFilter, ResponseEnvelopeInterceptor } from '@repo/kits'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { ProviderProbeService } from './provider-probe.service.js'

/** 内部：main 的「同步 / 连通性测试」入口（供应商交互只在网关） */
@Controller('internal/providers')
@UseGuards(InternalTokenGuard)
@UseFilters(AppExceptionFilter)
@UseInterceptors(ResponseEnvelopeInterceptor)
export class ProviderProbeController {
  constructor(@Inject(ProviderProbeService) private readonly probe: ProviderProbeService) {}

  @Post('list-models')
  @HttpCode(200)
  listModels(@Body({ schema: ProviderListModelsRequestSchema }) input: ProviderListModelsRequest) {
    return this.probe.listModels(input)
  }

  @Post('test')
  @HttpCode(200)
  test(@Body({ schema: ProviderProbeRequestSchema }) input: ProviderProbeRequest) {
    return this.probe.test(input)
  }
}
