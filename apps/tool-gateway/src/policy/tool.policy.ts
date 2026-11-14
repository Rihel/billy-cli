import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { getToolDefinition } from '@repo/tool-catalog'
import type { ToolInvokeRequest, ToolOutcome, ToolRuntimeSettings } from '@repo/contracts'
import { ToolConfigService } from '../config/tool.config.service.js'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'

export type PolicyResult =
  | { ok: true; input: Record<string, unknown>; settings: ToolRuntimeSettings }
  | { ok: false; outcome: Extract<ToolOutcome, { ok: false }> }

/**
 * 网关策略链的第一版：scope / validate / rate-limit。
 *
 * 后续 enabled / precheck / redact / paginate 按同一结构加；审计在 service 里统一记录。
 */
@Injectable()
export class ToolPolicyService {
  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(ToolConfigService) private readonly toolConfig: ToolConfigService,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async precheck(request: ToolInvokeRequest): Promise<PolicyResult> {
    const definition = getToolDefinition(request.toolKey)
    if (!definition) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: 'unknown-tool',
          message: `未知工具：${request.toolKey}`,
          retryable: false,
        },
      }
    }

    const effective = await this.toolConfig.effective(request.toolKey)
    if (!effective.enabled) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: 'disabled',
          message: `工具 ${request.toolKey} 已被停用`,
          retryable: false,
        },
      }
    }

    const scope = effective.scope ?? definition.scope
    const agentAllowed =
      scope !== 'agent' ||
      (effective.allowedAgents ?? []).includes(request.caller.agentKey) ||
      (effective.allowedAgents ?? []).includes(request.caller.rootAgentKey)
    if (
      (scope === 'admin' && !request.caller.isAdmin) ||
      (scope === 'user' && request.caller.isAdmin) ||
      !agentAllowed
    ) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: 'forbidden',
          message: `当前身份无权调用工具 ${request.toolKey}`,
          retryable: false,
        },
      }
    }

    const parsed = definition.params.safeParse(request.input)
    if (!parsed.success) {
      return {
        ok: false,
        outcome: {
          ok: false,
          reason: 'invalid-input',
          message: `工具参数不合法：${parsed.error.issues[0]?.message ?? '未知错误'}`,
          retryable: false,
        },
      }
    }

    // 限流按「用户（无用户时按会话）+ 工具 + 分钟窗口」；Redis 抖动 fail-open
    try {
      const subject = request.caller.userId ?? request.caller.conversationId
      const bucket = Math.floor(Date.now() / 60_000)
      const key = `ai:tool-rate:${subject}:${request.toolKey}:${bucket}`
      const used = await this.redis.incr(key)
      if (used === 1) await this.redis.expire(key, 60)
      const limit = Number(effective.limits.rateLimitPerMinute ?? this.config.rateLimitPerMinute)
      if (used > limit) {
        return {
          ok: false,
          outcome: {
            ok: false,
            reason: 'rate-limited',
            message: `该工具每分钟最多调用 ${limit} 次`,
            retryable: true,
          },
        }
      }
    } catch (error) {
      this.logger.warn('tool_gateway.rate_limit_unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    // 去掉 reason（模型必填，但 worker 不需要）与未知字段
    const input: Record<string, unknown> = { ...(parsed.data as Record<string, unknown>) }
    delete input.reason
    return {
      ok: true,
      input,
      settings: {
        config: effective.config,
        limits: effective.limits,
        secrets: effective.secrets,
        version: effective.version,
      },
    }
  }
}
