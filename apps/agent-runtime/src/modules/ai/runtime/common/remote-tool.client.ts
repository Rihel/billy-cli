import { CapabilityGatewayClient, InternalTransportError } from '@repo/internal-sdk'
import type { ToolDenyReasonValue, ToolOutcome } from '../../tools/engine/tools.types.js'
import type { RemoteToolInvoker } from '../../tools/engine/tool.ports.js'

/**
 * 网关的失败原因 → 我们的领域 reason（不认识的一律归 internal）。
 *
 * 执行面新增的领域原因必须在这里有映射：漏一个就会把「缺凭据 / 没绑工作区」翻成
 * `internal`（"我们写错了"），时间线与模型都读不懂（issue 11）。
 */
export const toReason = (reason: string): ToolDenyReasonValue => {
  if (reason === 'timeout' || reason === 'aborted') return reason
  if (reason === 'invalid-input') return 'invalid-input'
  if (reason === 'forbidden') return 'forbidden'
  if (reason === 'rate-limited') return 'rate-limited'
  if (reason === 'disabled') return 'disabled'
  if (reason === 'mcp-tool-error') return 'upstream'
  if (reason === 'unsupported-tool') return 'unknown-tool'
  // 前置条件不满足（缺凭据 / 没绑工作区 / 凭据入库失败）：可纠正，不是我们的内部错误
  if (reason === 'missing-credential' || reason === 'no-workspace' || reason === 'import-failed') {
    return 'precheck-failed'
  }
  if (
    reason === 'no-provider' ||
    reason === 'busy' ||
    reason === 'service-unavailable' ||
    reason === 'service-protocol-error' ||
    reason.startsWith('service-http-')
  ) {
    return 'upstream'
  }
  return 'internal'
}

/**
 * 可选能力：把 allowlist 里的工具**执行**转到能力网关（插件链仍在本进程先跑）。
 *
 * 只读环境变量，不进 AgentConfig：这是部署级开关，默认关；不设 `TOOL_GATEWAY_URL` 时返回 null，
 * 主链路行为与拆分前一致（本地 `spec.exec`）。
 *
 * 能力 key 就是工具名（`xxx-xxx`）；服务只是在网关里把这些工具登记成一组，runtime 不关心。
 */
export const createRemoteToolInvoker = (
  env: NodeJS.ProcessEnv = process.env,
): RemoteToolInvoker | null => {
  const url = env.TOOL_GATEWAY_URL?.trim()
  if (!url) return null

  const token =
    env.TOOL_GATEWAY_TOKEN?.trim() || env.TOOL_INTERNAL_TOKEN?.trim() || 'dev-tool-token'
  const tools = new Set(
    (
      env.TOOL_GATEWAY_TOOLS ??
      // 默认 = 登记在 `workspace` / `common` 两个服务上的全部 code 能力。
      // 新增能力必须同步这里：只登记不减白名单，模型面根本看不见它（issue 2）
      'bash,web-fetch,web-search,memory-save,memory-search,memory-forget,file-submit,file-download,file-list,read-file,file-search,workspace-files,write-file,replace-file,append-file,read-tool-result,web-request,wait-task,cancel-task,tool-search,credential-candidates,credential-import,credential-save'
    )
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const deadlineMs = Number(env.TOOL_GATEWAY_DEADLINE_MS ?? 310_000)
  const client = new CapabilityGatewayClient({ baseUrl: url, token, timeoutMs: deadlineMs })

  return {
    supports: (toolKey) => tools.has(toolKey),
    async invoke(input) {
      try {
        const result = await client.invoke(
          {
            capability: input.toolKey,
            input: input.input,
            caller: {
              conversationId: input.caller.conversationId,
              runId: input.caller.runId,
              userId: input.caller.userId,
              isAdmin: input.caller.isAdmin,
              agentKey: input.caller.agentKey,
              rootAgentKey: input.caller.rootAgentKey,
              depth: input.caller.depth,
            },
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            deadlineMs: input.deadlineMs,
            ...(input.toolCallId ? { idempotencyKey: input.toolCallId } : {}),
          },
          { timeoutMs: input.deadlineMs },
        )
        const outcome = result.outcome
        if (outcome.ok) return { ok: true, data: outcome.data }
        return {
          ok: false,
          reason: toReason(outcome.reason),
          message: outcome.message,
          ...(outcome.hint ? { hint: outcome.hint } : {}),
          ...(outcome.retryable !== undefined ? { retryable: outcome.retryable } : {}),
        }
      } catch (error) {
        const retryable = error instanceof InternalTransportError
        return {
          ok: false,
          reason: 'internal',
          message: `能力网关调用失败：${error instanceof Error ? error.message : String(error)}`,
          retryable,
        } as ToolOutcome
      }
    },
  }
}

/**
 * 停止一轮对话时**级联取消本轮发起的网关任务**（协议 §9）。
 *
 * 只取消网关记录的 `owner=session` 任务（`POST /v1/tasks/cancel-run`）——
 * `owner=user` / `tenant` 的业务任务不能因为关掉对话就回滚，那得走显式操作。
 * 失败只记 warn：本地停止流程不能被网关拖住。
 */
export const cancelRemoteRunTasks = async (
  runId: string,
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void },
): Promise<void> => {
  const url = process.env.TOOL_GATEWAY_URL?.trim()
  if (!url) return
  const token =
    process.env.TOOL_GATEWAY_TOKEN?.trim() ||
    process.env.TOOL_INTERNAL_TOKEN?.trim() ||
    'dev-tool-token'
  try {
    const client = new CapabilityGatewayClient({ baseUrl: url, token, timeoutMs: 3_000 })
    await client.cancelRunTasks(runId)
  } catch (error) {
    logger?.warn('ai.tool.task_cancel_failed', {
      runId,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}
