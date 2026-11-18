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
import { AppExceptionFilter, ResponseEnvelopeInterceptor } from '@repo/kits'
import {
  CapabilityInvokeRequestSchema,
  CapabilityListRequestSchema,
  CapabilityServiceStatusSchema,
  CapabilityTaskCancelSchema,
  CapabilityTaskQuerySchema,
  InstanceDeregisterSchema,
  InstanceHeartbeatSchema,
  ServiceDeregisterSchema,
  ServiceRegistrationSchema,
  type CapabilityInvokeRequest,
  type CapabilityInvokeResult,
  type CapabilityListRequest,
  type CapabilityListResponse,
  type CapabilityTaskCancel,
  type CapabilityTaskQuery,
  type CapabilityTaskSnapshot,
  type CapabilityServiceStatus,
  type InstanceDeregistration,
  type InstanceHeartbeat,
  type ServiceDeregistration,
  type ServiceRegistration,
  type ServiceRegisterResult,
} from '@repo/contracts'
import { randomUUID } from 'node:crypto'
import { ToolAuditService } from '../audit/tool.audit.js'
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

    const result = await this.invoker.invoke({ ...input, input: decision.input })
    await this.record(input, result)
    return result
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
      toolCallId: null,
      workerId: `${result.service}:${result.instanceId}`,
      outcome: result.outcome,
      durationMs: result.durationMs,
    })
  }
}
