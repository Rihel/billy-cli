import { Inject, Injectable } from '@nestjs/common'
import { CapabilityGatewayClient } from '@repo/internal-sdk'
import {
  ServiceRegistrationSchema,
  type RegisteredService,
  type ServiceRegistration,
} from '@repo/contracts'
import type {
  CapabilityServiceListDto,
  CapabilityServiceModel,
  CapabilityServiceSaveDto,
  CapabilityServiceStatusDto,
  CapabilityServiceTestDto,
  CapabilityServiceTestResultDto,
} from '@repo/shared'
import { AppLogger } from '@repo/kits'

const toModel = (service: RegisteredService): CapabilityServiceModel => ({
  service: service.service,
  title: service.title,
  owner: service.owner,
  source: service.source,
  healthPath: service.healthPath,
  status: service.status,
  allowHttp: service.allowHttp,
  version: service.version,
  updatedAt: service.updatedAt,
  hasCredential: service.auth?.hasCredential ?? false,
  capabilities: service.capabilities.map((item) => ({
    tool: item.tool,
    title: item.title,
    description: item.description,
    risk: item.risk,
  })),
  instances: Object.values(service.instances).map((item) => ({
    instanceId: item.instanceId,
    active: item.active,
    maxConcurrency: item.maxConcurrency,
  })),
  probe: { state: service.probe.state, lastProbedAt: service.probe.lastProbedAt },
  ...(service.description === undefined ? {} : { description: service.description }),
  ...(service.baseUrl === undefined ? {} : { baseUrl: service.baseUrl }),
})

/**
 * 后台「能力服务」管理：**网关是登记的唯一写方**，这里只做表单与转发。
 *
 * 三条口径：
 * - 列表不返回凭据，只给 `hasCredential`；
 * - 保存 = `source:'manual'` 的登记（同一个接口，外部服务由后台代提交）；
 * - 测试只测连通、拉清单只返回候选内容，都不落库。
 */
@Injectable()
export class CapabilityServiceAdminService {
  private readonly client = new CapabilityGatewayClient({
    baseUrl: process.env.TOOL_GATEWAY_URL?.trim() || 'http://127.0.0.1:9993',
    token:
      process.env.TOOL_GATEWAY_TOKEN?.trim() ||
      process.env.TOOL_INTERNAL_TOKEN?.trim() ||
      'dev-tool-token',
  })

  constructor(@Inject(AppLogger) private readonly logger: AppLogger) {}

  async list(input: CapabilityServiceListDto): Promise<CapabilityServiceModel[]> {
    const { services } = await this.client.listServices()
    const keyword = input.keyword?.trim()
    return services
      .map(toModel)
      .filter(
        (item) =>
          !keyword ||
          item.service.includes(keyword) ||
          item.title.includes(keyword) ||
          item.owner.includes(keyword),
      )
      .sort((left, right) => left.service.localeCompare(right.service))
  }

  async save(input: CapabilityServiceSaveDto): Promise<CapabilityServiceModel> {
    const registration: ServiceRegistration = ServiceRegistrationSchema.parse({
      protocolVersion: 1,
      service: input.service,
      title: input.title,
      owner: input.owner,
      source: 'manual',
      baseUrl: input.baseUrl,
      healthPath: input.healthPath,
      allowHttp: input.allowHttp,
      auth: {
        mode: input.auth.mode,
        header: input.auth.header,
        ...(input.auth.credential ? { credential: input.auth.credential } : {}),
      },
      capabilities: input.capabilities,
      ...(input.description === undefined ? {} : { description: input.description }),
    })
    await this.client.register(registration)
    const { services } = await this.client.listServices()
    const saved = services.find((item) => item.service === input.service)
    if (!saved) throw new Error(`登记成功但目录里找不到服务：${input.service}`)
    return toModel(saved)
  }

  async remove(input: { service: string }): Promise<{ removed: boolean }> {
    return this.client.deregisterService(input.service)
  }

  async setStatus(input: CapabilityServiceStatusDto): Promise<{ updated: boolean }> {
    return this.client.setStatus({ service: input.service, status: input.status })
  }

  /** 只测连通：GET {baseUrl}{healthPath}，不产生任何登记 */
  async test(input: CapabilityServiceTestDto): Promise<CapabilityServiceTestResultDto> {
    const url = new URL(input.healthPath, input.baseUrl)
    try {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3_000),
      })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      this.logger.warn('ai.capability.test_failed', {
        service: input.service ?? input.baseUrl,
        reason: error instanceof Error ? error.message : String(error),
      })
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 拉清单：`POST {baseUrl}/manifest`，把对方返回的内容原样交给页面确认 */
  async pullManifest(input: {
    baseUrl: string
    healthPath?: string
  }): Promise<Record<string, unknown>> {
    const response = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/manifest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`对方 /manifest 返回 ${response.status}`)
    const payload = (await response.json()) as unknown
    if (!payload || typeof payload !== 'object') throw new Error('对方 /manifest 不是 JSON 对象')
    return payload as Record<string, unknown>
  }
}
