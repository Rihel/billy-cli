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
import { AppExceptionFilter, AppLogger, ResponseEnvelopeInterceptor } from '@repo/kits'
import {
  CapabilityInvokeRequestSchema,
  CapabilityListRequestSchema,
  CapabilityServiceStatusSchema,
  CapabilityRunCancelSchema,
  CapabilityTaskCancelSchema,
  CapabilityTaskQuerySchema,
  InstanceDeregisterSchema,
  InstanceHeartbeatSchema,
  McpDiscoverSchema,
  ServiceDeregisterSchema,
  ServiceRegistrationSchema,
  type CapabilityDecl,
  type CapabilityInvokeRequest,
  type CapabilityInvokeResult,
  type CapabilityListRequest,
  type CapabilityListResponse,
  type CapabilityRunCancel,
  type CapabilityRunCancelResult,
  type CapabilityTaskCancel,
  type CapabilityTaskQuery,
  type CapabilityTaskSnapshot,
  type CapabilityServiceStatus,
  type InstanceDeregistration,
  type InstanceHeartbeat,
  type McpDiscover,
  type McpDiscoverResult,
  type RegisteredService,
  type ServiceDeregistration,
  type ServiceRegistration,
  type ServiceRegisterResult,
} from '@repo/contracts'
import { randomUUID } from 'node:crypto'
import { ToolAuditService } from '../audit/tool.audit.js'
import { canonicalHash } from '../effects/canonical-hash.js'
import { ToolEffectLedger } from '../effects/tool-effect.ledger.js'
import type { EffectDecision } from '../effects/tool-effect.types.js'
import { GATEWAY_SERVICE, findBuiltinCapability } from './builtin.capabilities.js'
import { searchTools } from './tool.search.js'
import { InternalTokenGuard } from '../http/internal-token.guard.js'
import { ZodBodyPipe } from '../http/zod-body.pipe.js'
import { CapabilityPolicyService } from './capability.policy.js'
import { ServiceInvoker } from './service.invoker.js'
import { ServiceRegistry } from './service.registry.js'

/**
 * 能力登记与调用（协议 §4.7 / §7）。
 *
 * 访问约定：**一律 POST + JSON body，不用路径参数**；只有探针是 GET（见根 controller）。
 * `service` / `instanceId` / `capability` 全在 body 里。
 */
@Controller()
@UseFilters(AppExceptionFilter)
export class CapabilityRegistryController {
  constructor(
    @Inject(ServiceRegistry) private readonly registry: ServiceRegistry,
    @Inject(ServiceInvoker) private readonly invoker: ServiceInvoker,
    @Inject(CapabilityPolicyService) private readonly policy: CapabilityPolicyService,
    @Inject(ToolAuditService) private readonly audit: ToolAuditService,
    @Inject(ToolEffectLedger) private readonly effects: ToolEffectLedger,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  /** 内部服务的每个实例启动时调一次；幂等，清单没变就是 no-op */
  @Post('v1/services/register')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async register(
    @Body(new ZodBodyPipe(ServiceRegistrationSchema)) input: ServiceRegistration,
  ): Promise<ServiceRegisterResult> {
    return this.registry.register(input)
  }

  /** 服务退役：整条记录删掉，能力从目录消失 */
  @Post('v1/services/deregister')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async deregisterService(
    @Body(new ZodBodyPipe(ServiceDeregisterSchema)) input: ServiceDeregistration,
  ): Promise<{ removed: boolean }> {
    return this.registry.deregisterService(input.service)
  }

  /** 实例心跳：只刷 active；返回 `known=false` 时客户端应重发 register */
  @Post('v1/instances/heartbeat')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async heartbeat(
    @Body(new ZodBodyPipe(InstanceHeartbeatSchema)) input: InstanceHeartbeat,
  ): Promise<{ known: boolean }> {
    return this.registry.heartbeat(input)
  }

  /** 实例摘除（优雅停机）：只摘流量，能力保留 */
  @Post('v1/instances/deregister')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async deregisterInstance(
    @Body(new ZodBodyPipe(InstanceDeregisterSchema)) input: InstanceDeregistration,
  ): Promise<{ removed: boolean }> {
    return this.registry.deregisterInstance(input.service, input.instanceId)
  }

  /** 能力目录（给上游 / 模型）：key 是规范 key，name 是模型面名字 */
  @Post('v1/capabilities/list')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async list(
    @Body(new ZodBodyPipe(CapabilityListRequestSchema)) input: CapabilityListRequest,
  ): Promise<CapabilityListResponse> {
    const capabilities = await this.registry.listFor({
      isAdmin: input.caller.isAdmin,
      userId: input.caller.userId,
      agentKey: input.agentKey,
      rootAgentKey: input.caller.rootAgentKey,
    })
    return { version: 1, capabilities }
  }

  /** 调一次能力：规范 key（或裸工具名）进，治理 → 路由 → 审计，统一结论出 */
  @Post('v1/capabilities/invoke')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async invoke(
    @Body(new ZodBodyPipe(CapabilityInvokeRequestSchema)) input: CapabilityInvokeRequest,
  ): Promise<CapabilityInvokeResult> {
    const startedAt = Date.now()

    // 网关内建能力（wait-task / cancel-task）：不转发，直接查本地的任务索引。
    // 回调已取消，轮询是拿长任务结果的唯一出路（协议 §10.1）。
    const builtin = findBuiltinCapability(input.capability)
    if (builtin) {
      const decision = await this.policy.precheck(
        { key: builtin.tool, capability: builtin },
        input.caller,
        input.input,
      )
      if (!decision.ok) {
        const result: CapabilityInvokeResult = {
          version: 1,
          requestId: randomUUID(),
          capability: builtin.tool,
          service: GATEWAY_SERVICE,
          instanceId: GATEWAY_SERVICE,
          durationMs: Date.now() - startedAt,
          outcome: decision.outcome,
        }
        await this.record(input, result)
        return result
      }
      let data: unknown
      if (builtin.tool === 'tool-search') {
        data = await this.runToolSearch(input, decision.input)
      } else {
        const taskId = String(decision.input.taskId)
        data =
          builtin.tool === 'wait-task'
            ? await this.invoker.getTask({
                taskId,
                ...(decision.input.waitMs === undefined
                  ? {}
                  : { waitMs: Number(decision.input.waitMs) }),
              })
            : await this.invoker.cancelTask(taskId)
      }
      const result: CapabilityInvokeResult = {
        version: 1,
        requestId: randomUUID(),
        capability: builtin.tool,
        service: GATEWAY_SERVICE,
        instanceId: GATEWAY_SERVICE,
        durationMs: Date.now() - startedAt,
        outcome: { ok: true, data },
      }
      await this.record(input, result)
      return result
    }

    const found = await this.registry.find(input.capability)
    if (!found) {
      const result: CapabilityInvokeResult = {
        version: 1,
        requestId: randomUUID(),
        capability: input.capability,
        service: '',
        instanceId: '',
        durationMs: Date.now() - startedAt,
        outcome: { ok: false, reason: 'no-provider', message: '没有这个能力', retryable: true },
      }
      await this.record(input, result)
      return result
    }

    if (!(await this.registry.canUseService(input.caller, found.service))) {
      const result: CapabilityInvokeResult = {
        version: 1,
        requestId: randomUUID(),
        capability: found.key,
        service: found.service.service,
        instanceId: '',
        durationMs: Date.now() - startedAt,
        outcome: {
          ok: false,
          reason: 'forbidden',
          message: '没有权限使用这个服务（请让管理员在「服务授权」里开通）',
          retryable: false,
        },
      }
      await this.record(input, result)
      return result
    }

    const decision = await this.policy.precheck(found, input.caller, input.input)
    if (!decision.ok) {
      const result: CapabilityInvokeResult = {
        version: 1,
        requestId: randomUUID(),
        capability: found.key,
        service: found.service.service,
        instanceId: '',
        durationMs: Date.now() - startedAt,
        outcome: decision.outcome,
      }
      await this.record(input, result)
      return result
    }

    const effect = await this.claimEffect(input, found, decision.input, startedAt)
    if (effect.kind === 'terminal') {
      await this.record(input, effect.result)
      return effect.result
    }

    const result = await this.invoker.invoke({ ...input, input: decision.input })
    // 任务亲和之外再记一行「哪轮发起的」：停止对话时按 runId 级联取消（只记 owner=session）
    if (result.task && found.capability.execution.owner === 'session') {
      await this.registry.saveRunTask(
        input.caller.runId,
        result.task.id,
        Math.ceil(found.capability.execution.maxRunMs / 1_000) + 3_600,
      )
    }
    // 结算必须带代际：超时后可能已经被别的执行者重新派发，旧代的结论不能写进新一代。
    // task 型调用顺带把任务号落进台账：停止对话时的兜底取消靠它。
    await this.settleEffect(input, effect.generation, result.outcome, result.task?.id ?? null)
    await this.record(input, result)
    return result
  }

  /** 后台：发现一个 MCP server 的工具（握手 + tools/list；不落库，供登记表单同步） */
  @Post('v1/services/mcp/list')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async discoverMcp(
    @Body(new ZodBodyPipe(McpDiscoverSchema)) input: McpDiscover,
  ): Promise<McpDiscoverResult> {
    return this.invoker.discoverMcp(input)
  }

  /** 后台：服务列表（不出凭据，只给有没有） */
  @Post('v1/services/list')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async listServices(): Promise<{ services: Awaited<ReturnType<ServiceRegistry['adminList']>> }> {
    return { services: await this.registry.adminList() }
  }

  /** 后台：启停一个服务（禁止靠挨个关工具来下线） */
  @Post('v1/services/status')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async setStatus(
    @Body(new ZodBodyPipe(CapabilityServiceStatusSchema)) input: CapabilityServiceStatus,
  ): Promise<{ updated: boolean }> {
    return this.registry.setStatus(input.service, input.status)
  }

  /** 查任务（长轮询）：按 taskId 回到发起它的实例 */
  @Post('v1/tasks/get')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async getTask(
    @Body(new ZodBodyPipe(CapabilityTaskQuerySchema)) input: CapabilityTaskQuery,
  ): Promise<CapabilityTaskSnapshot> {
    return this.invoker.getTask(input)
  }

  /** 停止一轮对话：级联取消本轮发起的 session 任务（幂等；user/tenant 任务不随对话取消） */
  @Post('v1/tasks/cancel-run')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async cancelRun(
    @Body(new ZodBodyPipe(CapabilityRunCancelSchema)) input: CapabilityRunCancel,
  ): Promise<CapabilityRunCancelResult> {
    // 两个来源取并集：Redis 映射是 best-effort（写失败 / 进程死在提交与映射之间都会丢），
    // 台账是持久事实。少取消一个任务 = 让它继续烧资源到自然结束。
    const mapped = await this.registry.runTaskIds(input.runId)
    let persisted: string[] = []
    let degraded = false
    try {
      persisted = await this.effects.taskIdsForRun(input.runId)
    } catch (error) {
      // 台账查不了 = 这轮只能取消 Redis 映射里的任务。不能静默当成「没有任务」，
      // 否则前端看到「已取消」而实际漏了任务 —— 明确降级并留 error 日志。
      degraded = true
      this.logger.error('tool_gateway.task_ids_query_failed', {
        runId: input.runId,
        mapped: mapped.length,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    const taskIds = [...new Set([...mapped, ...persisted])]
    const recovered = taskIds.length - mapped.length
    if (recovered > 0) {
      this.logger.warn('tool_gateway.task_ids_recovered', {
        runId: input.runId,
        recovered,
        mapped: mapped.length,
      })
    }
    let canceled = 0
    for (const taskId of taskIds) {
      const snapshot = await this.invoker.cancelTask(taskId)
      if (snapshot.state === 'canceled') canceled += 1
    }
    return { targets: taskIds.length, canceled, degraded }
  }

  /** 取消任务：幂等，终态时返回当前快照 */
  @Post('v1/tasks/cancel')
  @HttpCode(200)
  @UseGuards(InternalTokenGuard)
  @UseInterceptors(ResponseEnvelopeInterceptor)
  async cancelTask(
    @Body(new ZodBodyPipe(CapabilityTaskCancelSchema)) input: CapabilityTaskCancel,
  ): Promise<CapabilityTaskSnapshot> {
    return this.invoker.cancelTask(input.taskId)
  }

  /**
   * 工具检索：在当前身份**可见的能力目录**里跑 BM25。
   *
   * 用 `listFor(caller)` 而不是全量目录：越权工具不进结果，避免检索变成目录侧信道。
   * 只回 key / title / 说明 / 风险，不回完整 schema（命中后模型用工具自身的定义调用）。
   */
  private async runToolSearch(
    input: CapabilityInvokeRequest,
    parsed: Record<string, unknown>,
  ): Promise<unknown> {
    const query = typeof parsed.query === 'string' ? parsed.query : ''
    const limit = typeof parsed.limit === 'number' ? parsed.limit : 8
    const capabilities = await this.registry.listFor({
      isAdmin: input.caller.isAdmin,
      userId: input.caller.userId,
      agentKey: input.caller.agentKey,
      rootAgentKey: input.caller.rootAgentKey,
    })
    const docs = capabilities
      .filter((capability) => capability.key !== 'tool-search')
      .map((capability) => ({
        key: capability.key,
        title: capability.title,
        description: capability.description,
        tags: capability.tags,
        service: capability.service,
        risk: capability.risk,
      }))
    const hits = searchTools(query, docs, limit)
    const items = hits.map((hit) => ({
      key: hit.doc.key,
      title: hit.doc.title,
      description: hit.doc.description,
      service: hit.doc.service,
      risk: hit.doc.risk,
      score: Math.round(hit.score * 100) / 100,
    }))
    return {
      query,
      total: items.length,
      items,
      ...(items.length === 0
        ? { notice: '没有匹配的工具；换个关键词，或直接看当前的工具清单' }
        : {}),
    }
  }

  /**
   * 认领这次调用（`docs/design/tool-effect-ledger.md`）。
   *
   * 只在带了 `idempotencyKey`（runtime 传的是 Mastra 的 toolCallId）时建台账 ——
   * 那是「同一次调用」的唯一身份，没有它就没法判断重放，只能当普通调用。
   */
  private async claimEffect(
    input: CapabilityInvokeRequest,
    found: { key: string; capability: CapabilityDecl; service: RegisteredService },
    effectiveInput: Record<string, unknown>,
    startedAt: number,
  ): Promise<
    | { kind: 'run'; generation: number | null }
    | { kind: 'terminal'; result: CapabilityInvokeResult }
  > {
    const toolCallId = input.idempotencyKey
    if (!toolCallId) return { kind: 'run', generation: null }

    const policy = { risk: found.capability.risk, idempotent: found.capability.idempotent }
    let decision: EffectDecision
    try {
      decision = await this.effects.begin({
        runId: input.caller.runId,
        conversationId: input.caller.conversationId,
        toolCallId,
        capability: found.key,
        requestHash: canonicalHash({ capability: found.key, input: effectiveInput }),
        timeoutMs: input.deadlineMs,
        policy,
      })
    } catch (error) {
      // 台账写不进去 = 事后无法判断副作用是否发生。只读能力放行（代价是多跑一次查询），
      // 不可逆动作一律拒绝 —— 宁可这次调不通，也不要留下一个查不出来的副作用。
      this.logger.warn('tool_gateway.effect_ledger_unavailable', {
        capability: found.key,
        risk: policy.risk,
        reason: error instanceof Error ? error.message : String(error),
      })
      if (policy.risk === 'read') return { kind: 'run', generation: null }
      return {
        kind: 'terminal',
        result: this.effectResult(input, found, startedAt, {
          ok: false,
          reason: 'effect-ledger-unavailable',
          message: '副作用台账暂不可用，出于安全考虑本次写入类调用没有执行，请稍后重试。',
          retryable: true,
        }),
      }
    }

    if (decision.kind === 'proceed') return { kind: 'run', generation: decision.generation }
    if (decision.kind === 'replay') {
      this.logger.log('tool_gateway.effect_replayed', {
        capability: found.key,
        runId: input.caller.runId,
        toolCallId,
      })
      return {
        kind: 'terminal',
        result: this.effectResult(input, found, startedAt, decision.outcome),
      }
    }
    this.logger.warn('tool_gateway.effect_blocked', {
      capability: found.key,
      runId: input.caller.runId,
      toolCallId,
      reason: decision.reason,
    })
    return {
      kind: 'terminal',
      result: this.effectResult(input, found, startedAt, {
        ok: false,
        reason: decision.reason,
        message: decision.message,
        retryable: false,
      }),
    }
  }

  /**
   * 结算台账；失败只记日志（调用已经发生，翻成工具失败反而误导模型）。
   *
   * `generation` 为 null 表示这次调用没进台账（没有 `idempotencyKey`），直接跳过。
   */
  private async settleEffect(
    input: CapabilityInvokeRequest,
    generation: number | null,
    outcome: CapabilityInvokeResult['outcome'],
    taskId: string | null,
  ): Promise<void> {
    const toolCallId = input.idempotencyKey
    if (!toolCallId || generation === null) return
    try {
      const result = await this.effects.settle({
        runId: input.caller.runId,
        toolCallId,
        generation,
        outcome,
        taskId,
      })
      if (result === 'stale') {
        // 旧代的迟到响应，或结算前已被判 unknown：结论只留在审计里，不改台账
        this.logger.warn('tool_gateway.effect_settle_stale', {
          runId: input.caller.runId,
          toolCallId,
          generation,
        })
        return
      }
      if (result === 'archived') {
        // 这一代当时已经判成 unknown：状态不动，但把真实结论补进台账留档
        this.logger.warn('tool_gateway.effect_settle_archived', {
          runId: input.caller.runId,
          toolCallId,
          generation,
        })
      }
    } catch (error) {
      this.logger.error('tool_gateway.effect_settle_failed', {
        runId: input.caller.runId,
        toolCallId,
        generation,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 台账结论直接回给调用方时用的结果壳（不经过服务，`instanceId` 记台账） */
  private effectResult(
    input: CapabilityInvokeRequest,
    found: { key: string; service: RegisteredService },
    startedAt: number,
    outcome: CapabilityInvokeResult['outcome'],
  ): CapabilityInvokeResult {
    return {
      version: 1,
      requestId: randomUUID(),
      capability: found.key,
      service: found.service.service,
      instanceId: 'effect-ledger',
      durationMs: Date.now() - startedAt,
      outcome,
    }
  }

  /** 审计写失败不阻断结论；网关是 ai_tool_audit 的唯一写方 */
  private async record(
    input: CapabilityInvokeRequest,
    result: CapabilityInvokeResult,
  ): Promise<void> {
    await this.audit.record({
      requestId: result.requestId,
      runId: input.caller.runId,
      conversationId: input.caller.conversationId,
      userId: input.caller.userId ?? null,
      toolKey: result.capability,
      // 与副作用台账同一个句柄：审计与台账可以按 (runId, toolCallId) 对账
      toolCallId: input.idempotencyKey ?? null,
      workerId: `${result.service}:${result.instanceId}`,
      outcome: result.outcome,
      durationMs: result.durationMs,
    })
  }
}
