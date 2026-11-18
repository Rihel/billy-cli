import { Inject, Injectable } from '@nestjs/common'
import { AppLogger, RedisStore } from '@repo/kits'
import { z } from 'zod'
import type { CapabilityDecl, ToolCaller, ToolOutcome } from '@repo/contracts'
import { ToolConfigService } from '../config/tool.config.service.js'
import { ToolGatewayConfig, type ToolGatewayConfigValue } from '../config/app-config.js'

export type CapabilityPolicyResult =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; outcome: Extract<ToolOutcome, { ok: false }> }

const deny = (reason: string, message: string, retryable = false): CapabilityPolicyResult => ({
  ok: false,
  outcome: { ok: false, reason, message, retryable },
})

/** JSON Schema → zod 做入参校验；转不动就跳过（交给服务自己兜） */
const validateInput = (
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): string | null => {
  try {
    const converter = (z as unknown as { fromJSONSchema?: (raw: unknown) => z.ZodType })
      .fromJSONSchema
    if (!converter) return null
    const parsed = converter(schema).safeParse(input)
    return parsed.success ? null : (parsed.error.issues[0]?.message ?? '参数不合法')
  } catch {
    return null
  }
}

/**
 * 新调用链（`/v1/capabilities/invoke`）的治理：enabled / scope / 入参 / 限流。
 *
 * 与旧的 `ToolPolicyService` 同一套口径，区别是：
 * - 目录来自注册表（能力声明），配置仍读 `ai_tools`（key 是规范 key）；
 * - 入参按**注册时上报的 JSON Schema** 校验，而不是代码里的 zod。
 */
@Injectable()
export class CapabilityPolicyService {
  constructor(
    @Inject(RedisStore) private readonly redis: RedisStore,
    @Inject(ToolConfigService) private readonly toolConfig: ToolConfigService,
    @Inject(ToolGatewayConfig) private readonly config: ToolGatewayConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async precheck(
    found: { key: string; capability: CapabilityDecl },
    caller: ToolCaller,
    input: Record<string, unknown>,
  ): Promise<CapabilityPolicyResult> {
    const effective = await this.toolConfig.effective(found.key)
    if (!effective.enabled) {
      return deny('disabled', `能力 ${found.key} 已被停用`)
    }

    const scope = effective.scope ?? found.capability.scope
    const allowedAgents = effective.allowedAgents ?? found.capability.allowedAgents ?? []
    const agentAllowed =
      scope !== 'agent' ||
      allowedAgents.includes(caller.agentKey) ||
      allowedAgents.includes(caller.rootAgentKey)
    if (
      (scope === 'admin' && !caller.isAdmin) ||
      (scope === 'user' && caller.isAdmin) ||
      !agentAllowed
    ) {
      return deny('forbidden', `当前身份无权调用能力 ${found.key}`)
    }

    const issue = validateInput(found.capability.inputSchema, input)
    if (issue) {
      return deny('invalid-input', `参数不合法：${issue}`)
    }

    // 限流：用户（无用户时按会话）+ 规范 key + 分钟窗口；Redis 抖动 fail-open
    try {
      const subject = caller.userId ?? caller.conversationId
      const bucket = Math.floor(Date.now() / 60_000)
      const key = `ai:capability-rate:${subject}:${found.key}:${bucket}`
      const used = await this.redis.incr(key)
      if (used === 1) await this.redis.expire(key, 60)
      const limit = Number(effective.limits.rateLimitPerMinute ?? this.config.rateLimitPerMinute)
      if (used > limit) {
        return deny('rate-limited', `该能力每分钟最多调用 ${limit} 次`, true)
      }
    } catch (error) {
      this.logger.warn('capability_gateway.rate_limit_unavailable', {
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    return { ok: true, input }
  }
}
