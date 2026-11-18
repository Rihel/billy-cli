import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import {
  CapabilityInvokeResponseSchema,
  CapabilityTaskSnapshotSchema,
  type CapabilityInvokeRequest,
  type CapabilityInvokeResult,
  type CapabilityTaskQuery,
  type CapabilityTaskSnapshot,
  type McpDiscover,
  type McpDiscoverResult,
  type RegisteredService,
} from '@repo/contracts'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'
import { ToolConfigService } from '../config/tool.config.service.js'
import { UnsafeTargetError, allowPrivateNetworkOf, assertSafeTarget } from './target.guard.js'
import { callMcpTool, discoverMcpTools } from './mcp.client.js'
import { ServiceRegistry } from './service.registry.js'

/**
 * 把一次能力调用转发给服务（协议 §7 / §9）。
 *
 * 只有三件事：拼 body、带凭据、按超时发出去、把结果翻成统一结论。
 * 治理（scope / 限额 / 审计）在 controller 那一层，不在这里。
 */
@Injectable()
export class ServiceInvoker {
  constructor(
    @Inject(ServiceRegistry) private readonly registry: ServiceRegistry,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    /** 工具级配置（`ai_tools` 的 config / limits / secrets）：调用前随 `x-capability-config` 下发 */
    @Optional() @Inject(ToolConfigService) private readonly toolConfig?: ToolConfigService,
    @Optional() @Inject(AppLogger) private readonly logger?: AppLogger,
  ) {}

  async invoke(request: CapabilityInvokeRequest): Promise<CapabilityInvokeResult> {
    const startedAt = Date.now()
    // 允许不带 namespace：`bash` 也能找到 `exec/bash`（唯一命中才算数）
    const found = await this.registry.find(request.capability)
    if (!found) {
      return this.fail(request, '', '', startedAt, 'no-provider', '没有这个能力', true)
    }
    // MCP 服务：走 MCP client（JSON-RPC initialize / tools/call），不转发 /invoke
    if (found.service.protocol === 'mcp') {
      return this.invokeMcp(found, request, startedAt)
    }

    const target = await this.registry.pick(found.key)
    if (!target) {
      return this.fail(
        request,
        found.service.service,
        '',
        startedAt,
        'no-provider',
        '服务没有可用实例',
        true,
      )
    }

    const timeoutMs = Math.min(request.deadlineMs, this.config.invokeTimeoutMs)
    const requestId = randomUUID()
    const body = {
      version: 1 as const,
      requestId,
      tool: found.capability.tool,
      input: request.input,
      reason: request.reason ?? '',
      caller: request.caller,
      deadlineMs: timeoutMs,
      ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
    }

    // 只校验外部服务：内部实例地址由部署给（可能本来就是内网 http），不套 SSRF 规则
    if (target.service.source === 'manual') {
      if (target.service.allowHttp && target.endpoint.startsWith('http://')) {
        this.logger?.warn('capability_gateway.insecure_target', {
          service: target.service.service,
          endpoint: target.endpoint,
          reason: 'allowHttp=true：调用走明文 http（联调标记，生产禁止）',
        })
      }
      try {
        await assertSafeTarget(target.endpoint, {
          allowHttp: target.service.allowHttp,
          allowPrivateNetwork: allowPrivateNetworkOf(this.config.allowPrivateNetwork),
        })
      } catch (error) {
        if (!(error instanceof UnsafeTargetError)) throw error
        return this.fail(
          request,
          target.service.service,
          target.instanceId,
          startedAt,
          'unsafe-target',
          error.message,
          false,
        )
      }
    }

    let response: Response
    try {
      response = await fetch(`${target.endpoint.replace(/\/+$/, '')}/invoke`, {
        method: 'POST',
        headers: await this.headersFor(target.service, found.key),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      return this.fail(
        request,
        target.service.service,
        target.instanceId,
        startedAt,
        isTimeout(error) ? 'timeout' : 'service-unavailable',
        isTimeout(error)
          ? `能力执行超时（${timeoutMs}ms）`
          : `无法连接服务：${error instanceof Error ? error.message : String(error)}`,
        true,
      )
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      return this.fail(
        request,
        target.service.service,
        target.instanceId,
        startedAt,
        `service-http-${response.status}`,
        `服务返回 ${response.status}${detail ? `：${detail}` : ''}`,
        response.status >= 500,
      )
    }

    const payload = await response.json().catch(() => null)
    const parsed = CapabilityInvokeResponseSchema.safeParse(payload)
    if (!parsed.success) {
      return this.fail(
        request,
        target.service.service,
        target.instanceId,
        startedAt,
        'service-protocol-error',
        '服务返回了不符合契约的响应',
        false,
      )
    }

    const value = parsed.data
    if (value.task) {
      // 任务亲和：wait / cancel 要回到发起它的那个实例
      await this.registry.saveTask(
        value.task.id,
        {
          service: target.service.service,
          endpoint: target.endpoint,
          instanceId: target.instanceId,
          capability: found.key,
        },
        Math.ceil(found.capability.execution.maxRunMs / 1_000) + 3_600,
      )
    }

    const outcome = value.ok
      ? {
          ok: true as const,
          data: value.data ?? (value.task === undefined ? null : { task: value.task }),
        }
      : {
          ok: false as const,
          reason: value.reason ?? 'service-error',
          message: value.message ?? '服务返回失败',
          ...(value.hint === undefined ? {} : { hint: value.hint }),
          ...(value.retryable === undefined ? {} : { retryable: value.retryable }),
        }

    return {
      version: 1,
      requestId,
      capability: found.key,
      service: target.service.service,
      instanceId: target.instanceId,
      durationMs: Date.now() - startedAt,
      ...(value.task === undefined ? {} : { task: value.task }),
      outcome,
    }
  }

  /** 发现一个 MCP server 的工具（后台「同步能力清单」用；不落库） */
  async discoverMcp(input: McpDiscover): Promise<McpDiscoverResult> {
    return discoverMcpTools({
      url: input.url,
      headers: input.headers ?? {},
      allowHttp: input.allowHttp,
      allowPrivateNetwork: allowPrivateNetworkOf(this.config.allowPrivateNetwork),
    })
  }

  /** MCP invoke：按登记的 headers 注入鉴权，按 `remoteTool` 原名调用 */
  private async invokeMcp(
    found: { service: RegisteredService; capability: { tool: string; remoteTool?: string } },
    request: CapabilityInvokeRequest,
    startedAt: number,
  ): Promise<CapabilityInvokeResult> {
    const service = found.service
    const fail = (reason: string, message: string, retryable: boolean): CapabilityInvokeResult => ({
      version: 1,
      requestId: randomUUID(),
      capability: found.capability.tool,
      service: service.service,
      instanceId: 'mcp',
      durationMs: Date.now() - startedAt,
      outcome: { ok: false, reason, message, retryable },
    })
    if (!service.baseUrl) return fail('no-provider', 'MCP 服务没有 baseUrl', false)

    const headers: Record<string, string> = {}
    if (service.auth?.header) {
      const credential = await this.registry.credentialFor(service.service)
      if (credential) headers[service.auth.header] = credential
    }
    if (service.allowHttp && service.baseUrl.startsWith('http://')) {
      this.logger?.warn('capability_gateway.insecure_target', {
        service: service.service,
        endpoint: service.baseUrl,
        reason: 'allowHttp=true：MCP 调用走明文 http（联调标记，生产禁止）',
      })
    }

    const result = await callMcpTool({
      url: new URL(service.healthPath || '/', service.baseUrl).toString(),
      headers,
      allowHttp: service.allowHttp,
      allowPrivateNetwork: allowPrivateNetworkOf(this.config.allowPrivateNetwork),
      remoteTool: found.capability.remoteTool ?? found.capability.tool,
      args: request.input,
      // MCP 的 HTTP 等待跟这次调用预算走（fetch 类工具经常超过 10s）
      timeoutMs: Math.max(1_000, request.deadlineMs - 500),
    })
    return {
      version: 1,
      requestId: randomUUID(),
      capability: found.capability.tool,
      service: service.service,
      instanceId: 'mcp',
      durationMs: Date.now() - startedAt,
      outcome: result.ok
        ? { ok: true, data: result.data }
        : {
            ok: false,
            reason: result.reason,
            message: result.message,
            retryable: result.retryable,
          },
    }
  }

  /** 查任务：按 `taskId → 实例` 的映射回到原实例（长轮询窗口透传） */
  async getTask(query: CapabilityTaskQuery): Promise<CapabilityTaskSnapshot> {
    const location = await this.registry.taskLocation(query.taskId)
    if (!location) return { version: 1, id: query.taskId, state: 'expired' }
    const service = await this.registry.getService(location.service)
    if (!service) return { version: 1, id: query.taskId, state: 'expired' }
    return this.callTask(service, location.endpoint, '/tasks/get', {
      taskId: query.taskId,
      ...(query.waitMs === undefined ? {} : { waitMs: query.waitMs }),
    })
  }

  /** 取消任务：幂等，服务已到终态时返回当前快照 */
  async cancelTask(taskId: string): Promise<CapabilityTaskSnapshot> {
    const location = await this.registry.taskLocation(taskId)
    if (!location) return { version: 1, id: taskId, state: 'expired' }
    const service = await this.registry.getService(location.service)
    if (!service) return { version: 1, id: taskId, state: 'expired' }
    return this.callTask(service, location.endpoint, '/tasks/cancel', { taskId })
  }

  private async callTask(
    service: RegisteredService,
    endpoint: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<CapabilityTaskSnapshot> {
    const taskId = String(body.taskId)
    try {
      const response = await fetch(`${endpoint.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: await this.headersFor(service, service.service),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const parsed = CapabilityTaskSnapshotSchema.safeParse(await response.json().catch(() => null))
      if (!response.ok || !parsed.success) {
        return {
          version: 1,
          id: taskId,
          state: 'failed',
          error: { reason: 'task-protocol-error', message: '服务返回了不符合契约的任务快照' },
        }
      }
      return parsed.data
    } catch (error) {
      return {
        version: 1,
        id: taskId,
        state: 'failed',
        error: {
          reason: isTimeout(error) ? 'timeout' : 'service-unavailable',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  /** 凭据：外部服务用自己配的 header + 值；内部服务用网关的内部令牌 */
  private async headersFor(
    service: RegisteredService,
    capabilityKey: string,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-capability-key': capabilityKey,
    }
    if (service.source === 'manual') {
      const credential = await this.registry.credentialFor(service.service)
      if (credential) headers[service.auth?.header ?? 'authorization'] = credential
    } else {
      headers['x-internal-token'] = this.config.internalToken
    }
    // 工具级配置：没有配置行 / 全空就不带这个头（服务按自己的部署默认跑）
    if (this.toolConfig) {
      const effective = await this.toolConfig.effective(capabilityKey)
      const settings = {
        config: effective.config,
        limits: effective.limits,
        secrets: effective.secrets,
        version: effective.version,
      }
      const hasContent =
        Object.keys(settings.config).length > 0 ||
        Object.keys(settings.limits).length > 0 ||
        Object.keys(settings.secrets).length > 0
      if (hasContent) headers['x-capability-config'] = encodeSettings(settings)
    }
    return headers
  }

  private fail(
    request: CapabilityInvokeRequest,
    service: string,
    instanceId: string,
    startedAt: number,
    reason: string,
    message: string,
    retryable: boolean,
  ): CapabilityInvokeResult {
    return {
      version: 1,
      requestId: randomUUID(),
      capability: request.capability,
      service,
      instanceId,
      durationMs: Date.now() - startedAt,
      outcome: { ok: false, reason, message, retryable },
    }
  }
}

const isTimeout = (error: unknown): boolean => {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * 配置头的编码：默认是 ASCII JSON；含非 ASCII 时退到 `b64:` + base64url(JSON)。
 *
 * HTTP 头只能放 ASCII，而 `config` 里可能出现中文（例如 baseUrl 之外的自定义文案），
 * 所以服务侧要按同一个约定解码（见 `common-capability` 的 `invoke.controller`）。
 */
const encodeSettings = (settings: Record<string, unknown>): string => {
  const json = JSON.stringify(settings)
  return /^[\x20-\x7E]*$/.test(json)
    ? json
    : `b64:${Buffer.from(json, 'utf8').toString('base64url')}`
}
