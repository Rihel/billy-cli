import { Inject, Injectable } from '@nestjs/common'
import { CapabilityGatewayClient } from '@repo/internal-sdk'
import {
  ServiceRegistrationSchema,
  type RegisteredService,
  type ServiceRegistration,
} from '@repo/contracts'
import type {
  CapabilityServiceCapabilityDto,
  CapabilityServiceListDto,
  CapabilityServiceMcpPullDto,
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
  protocol: service.protocol,
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
    inputSchema: item.inputSchema,
    risk: item.risk,
    ...(item.remoteTool === undefined ? {} : { remoteTool: item.remoteTool }),
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

  /**
   * 保存 = 登记 + **两项自检**（协议 §4.3）：测试连通 + 冒烟调用。
   *
   * 顺序：先按 `draft` 登记（不阻断保存），再跑自检；两项都过才切 `active`，否则留在 `draft`
   * 并把原因返回给页面。修改 baseUrl / 鉴权 / 清单会重新走一遍，等于"改完自动回 draft"。
   */
  async save(input: CapabilityServiceSaveDto): Promise<CapabilityServiceModel> {
    const registration: ServiceRegistration = ServiceRegistrationSchema.parse({
      protocolVersion: 1,
      service: input.service,
      title: input.title,
      owner: input.owner,
      source: 'manual',
      protocol: input.protocol,
      status: 'draft',
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

    const selfCheck = await this.runSelfCheck(input)
    const active = selfCheck.connected && selfCheck.smoke
    await this.client.setStatus({ service: input.service, status: active ? 'active' : 'draft' })

    const { services } = await this.client.listServices()
    const saved = services.find((item) => item.service === input.service)
    if (!saved) throw new Error(`登记成功但目录里找不到服务：${input.service}`)
    return { ...toModel(saved), selfCheck }
  }

  /** 两项自检：连通（GET healthPath）+ 冒烟（POST /invoke 一次，按协议回 ok:true 或可解释的 ok:false） */
  private async runSelfCheck(
    input: CapabilityServiceSaveDto,
  ): Promise<NonNullable<CapabilityServiceModel['selfCheck']>> {
    if (input.protocol === 'mcp') return this.runMcpSelfCheck(input)

    const connectivity = await this.test({
      service: input.service,
      baseUrl: input.baseUrl,
      healthPath: input.healthPath,
    })
    const smoke = await this.smoke(input)
    const failed: string[] = []
    if (!connectivity.ok) {
      failed.push(`测试连通失败（${connectivity.status ?? connectivity.message ?? '无响应'}）`)
    }
    if (!smoke.ok) failed.push(`冒烟调用失败（${smoke.message ?? '对方没有按协议回应'}）`)
    return {
      connected: connectivity.ok,
      smoke: smoke.ok,
      ...(failed.length > 0 ? { message: failed.join('；') } : {}),
    }
  }

  /**
   * MCP 自检：握手 + `tools/list`。
   *
   * MCP 没有 `/healthz` 也没有 `/invoke`，能连上并列出工具就说明"说的是 MCP 协议、凭据也对"；
   * 列不出工具就当冒烟失败（目录为空，登记了也没意义）。
   */
  private async runMcpSelfCheck(
    input: CapabilityServiceSaveDto,
  ): Promise<NonNullable<CapabilityServiceModel['selfCheck']>> {
    const url = new URL(input.healthPath || '/', input.baseUrl).toString()
    const headers: Record<string, string> = {}
    if (input.auth.credential) headers[input.auth.header || 'authorization'] = input.auth.credential
    try {
      const tools = await this.pullMcp({
        url,
        headers,
        allowHttp: input.baseUrl.startsWith('http://'),
      })
      return {
        connected: true,
        smoke: tools.length > 0,
        ...(tools.length === 0 ? { message: 'MCP server 没有列出任何工具' } : {}),
      }
    } catch (error) {
      return {
        connected: false,
        smoke: false,
        message: `MCP 握手失败（${error instanceof Error ? error.message : String(error)}）`,
      }
    }
  }

  /**
   * 冒烟调用：拿第一条能力、空入参发一次 `/invoke`。
   *
   * 判定只看"对方会不会按协议说话"：HTTP 200 + `{version:1, ok:boolean}` 就算通过——
   * 业务失败（`ok:false` + `reason`）也是合格回应（协议 §4.3 原话），不要求这次调用成功。
   */
  private async smoke(input: CapabilityServiceSaveDto): Promise<{ ok: boolean; message?: string }> {
    const capability = input.capabilities[0]
    if (!capability) return { ok: false, message: '能力清单为空' }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (input.auth.credential) {
      headers[input.auth.header || 'authorization'] = input.auth.credential
    }
    try {
      const response = await fetch(`${input.baseUrl.replace(/\/+$/, '')}/invoke`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          version: 1,
          requestId: `smoke-${Date.now()}`,
          tool: capability.tool,
          input: {},
          reason: '后台登记冒烟调用',
          caller: {
            conversationId: 'smoke',
            runId: 'smoke',
            agentKey: 'admin',
            rootAgentKey: 'admin',
            depth: 0,
          },
          deadlineMs: 5_000,
        }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!response.ok) return { ok: false, message: `/invoke 返回 ${response.status}` }
      const payload = (await response.json().catch(() => null)) as {
        version?: number
        ok?: boolean
        reason?: string
      } | null
      if (!payload || payload.version !== 1 || typeof payload.ok !== 'boolean') {
        return { ok: false, message: '/invoke 的响应不是协议样式' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
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

  /** 从 MCP server 拉工具清单（网关的 MCP client 执行握手 + tools/list；不落库） */
  async pullMcp(input: CapabilityServiceMcpPullDto): Promise<CapabilityServiceCapabilityDto[]> {
    const { tools } = await this.client.discoverMcp({
      url: input.url,
      headers: input.headers ?? {},
      allowHttp: input.allowHttp,
    })
    return tools.map((tool) => ({
      tool: tool.key,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      risk: 'read' as const,
      remoteTool: tool.remoteTool,
    }))
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
