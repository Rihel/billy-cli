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

/**
 * 入参校验有三种结局，别把后两种混成一种：
 *
 * - `valid`：校验通过；
 * - `invalid`：校验器判定参数不合法 → 拒绝；
 * - `unsupported`：**校验器本身用不了**（zod 没有 `fromJSONSchema` / schema 转不动 / 解析器抛错）。
 *   这是「不知道合不合法」，不是「合法」。只读能力可以兼容放行（旧行为），
 *   写入类能力必须拒绝 —— 否则安全边界会退化成建议。
 */
type ValidationResult =
  | { state: 'valid' }
  | { state: 'invalid'; issue: string }
  | { state: 'unsupported' }

const validateInput = (
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
): ValidationResult => {
  const converter = (z as unknown as { fromJSONSchema?: (raw: unknown) => z.ZodType })
    .fromJSONSchema
  if (!converter) return { state: 'unsupported' }
  let validator: z.ZodType
  try {
    validator = converter(schema)
  } catch {
    return { state: 'unsupported' }
  }
  try {
    const parsed = validator.safeParse(input)
    return parsed.success
      ? { state: 'valid' }
      : { state: 'invalid', issue: parsed.error.issues[0]?.message ?? '参数不合法' }
  } catch {
    return { state: 'unsupported' }
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

    const validation = validateInput(found.capability.inputSchema, input)
    if (validation.state === 'invalid') {
      return deny('invalid-input', `参数不合法：${validation.issue}`)
    }
    if (validation.state === 'unsupported') {
      // 写入类能力不接受「校验不了但先跑起来」：校验器不可用 = 安全边界不可用
      if (found.capability.risk === 'write') {
        return deny(
          'validator-unavailable',
          `能力 ${found.key} 的入参校验器不可用，出于安全考虑拒绝写入类调用`,
        )
      }
      this.logger.warn('capability_gateway.validation_skipped', {
        capability: found.key,
        risk: found.capability.risk,
        reason: '入参 schema 转不成校验器，只读能力按兼容放行',
      })
    }

    // 限流：用户（无用户时按会话）+ 规范 key + 分钟窗口。
    // Redis 抖动时的降级按能力风险区分：只读 fail-open（多花一次调用），写入 fail-closed。
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
      if (found.capability.risk === 'write') {
        return deny(
          'rate-limit-unavailable',
          `限流组件暂不可用，写入类能力按安全优先拒绝调用（${found.key}），请稍后重试`,
          true,
        )
      }
      this.logger.warn('capability_gateway.rate_limit_unavailable', {
        capability: found.key,
        risk: found.capability.risk,
        reason: error instanceof Error ? error.message : String(error),
      })
    }

    return { ok: true, input }
  }
}
