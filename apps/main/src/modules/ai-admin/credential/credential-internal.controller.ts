import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  UnauthorizedException,
} from '@nestjs/common'
import { CredentialImportRequestSchema, CredentialResolveRequestSchema } from '@repo/contracts'
import type {
  CredentialImportRequest,
  CredentialImportResponse,
  CredentialResolveRequest,
  CredentialResolveResponse,
} from '@repo/contracts'
import { CREDENTIAL_CONFIG, type CredentialModuleConfig } from './credential.config.js'
import { CredentialResolveService } from './credential-resolve.service.js'
import { PersonalCredentialService } from './credential.service.js'

/**
 * 凭据解析的内部入口（`POST /internal/credentials/resolve`，§6.4.6）。
 *
 * 为什么必须独立鉴权：请求里带的是**目标归属主体**（ownerType / ownerId），不是当前登录人。
 * 公网接口拿它就能以任意人的身份取凭据，因此只允许内部令牌调用。
 */
@Controller('internal/credentials')
export class CredentialInternalController {
  constructor(
    @Inject(CredentialResolveService) private readonly service: CredentialResolveService,
    @Inject(PersonalCredentialService) private readonly credentials: PersonalCredentialService,
    @Inject(CREDENTIAL_CONFIG) private readonly config: CredentialModuleConfig,
  ) {}

  @Post('resolve')
  @HttpCode(200)
  resolve(
    @Headers('x-internal-token') token: string | undefined,
    @Body({ schema: CredentialResolveRequestSchema }) input: CredentialResolveRequest,
  ): Promise<CredentialResolveResponse> {
    this.requireToken(token)
    return this.service.resolve(input)
  }

  /** 工作区导入：执行面在容器内读到值后交给这里加密入库（值不回显） */
  @Post('import')
  @HttpCode(200)
  async import(
    @Headers('x-internal-token') token: string | undefined,
    @Body({ schema: CredentialImportRequestSchema }) input: CredentialImportRequest,
  ): Promise<CredentialImportResponse> {
    this.requireToken(token)
    const credential = await this.credentials.importForOwner(
      { ownerType: input.ownerType, ownerId: input.ownerId },
      {
        provider: input.provider,
        ...(input.name ? { name: input.name } : {}),
        ...(input.template ? { template: input.template } : {}),
        ...(input.lifetime ? { lifetime: input.lifetime } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        values: input.values,
      },
    )
    return {
      credential: {
        id: credential.id,
        name: credential.name,
        provider: credential.provider,
        status: credential.status,
      },
    }
  }

  private requireToken(token: string | undefined): void {
    if (!token || token !== this.config.internalToken) {
      throw new UnauthorizedException('内部令牌不正确')
    }
  }
}
