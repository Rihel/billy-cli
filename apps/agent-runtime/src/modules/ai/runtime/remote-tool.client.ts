import { InternalApiError, InternalTransportError, ToolGatewayClient } from '@repo/internal-sdk'
import { TOOL_CONTRACT_VERSION } from '@repo/contracts'
import type { ToolDenyReasonValue, ToolOutcome } from '../core/tools/tools.types.js'
import type { RemoteToolInvoker } from '../core/tools/tool.ports.js'

/** worker / 网关的失败原因 → 我们的领域 reason（不认识的一律归 internal） */
const toReason = (reason: string): ToolDenyReasonValue => {
  if (reason === 'timeout' || reason === 'aborted') return reason
  if (reason === 'invalid-input') return 'invalid-input'
  if (reason === 'forbidden') return 'forbidden'
  if (reason === 'rate-limited') return 'rate-limited'
  if (reason === 'disabled') return 'disabled'
  if (
    reason === 'no-worker' ||
    reason === 'busy' ||
    reason === 'worker-unavailable' ||
    reason.startsWith('worker-http-')
  ) {
    return 'upstream'
  }
  return 'internal'
}

/**
 * 可选能力：把 allowlist 里的工具**执行**转到 tool-gateway（插件链仍在本进程先跑）。
 *
 * 只读环境变量，不进 AgentConfig：这是部署级开关，默认关；不设 `TOOL_GATEWAY_URL` 时返回 null，
 * 主链路行为与拆分前完全一致（本地 `spec.exec`）。
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
      'bash,web-fetch,web-search,memory-save,memory-search,memory-forget,file-submit,file-download,file-list,read-file,file-search,workspace-files,write-file,replace-file,append-file,read-tool-result,web-request'
    )
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  const deadlineMs = Number(env.TOOL_GATEWAY_DEADLINE_MS ?? 30_000)
  const client = new ToolGatewayClient({ baseUrl: url, token, timeoutMs: deadlineMs })

  return {
    supports: (toolKey) => tools.has(toolKey),
    async invoke(input) {
      try {
        const response = await client.invokeTool(
          {
            version: TOOL_CONTRACT_VERSION,
            requestId: input.toolCallId ?? `${input.toolKey}-${Date.now()}`,
            toolKey: input.toolKey,
            toolCallId: input.toolCallId,
            input: input.input,
            ...(input.workspaceConversationId
              ? { workspaceConversationId: input.workspaceConversationId }
              : {}),
            caller: {
              conversationId: input.caller.conversationId,
              runId: input.caller.runId,
              userId: input.caller.userId,
              isAdmin: input.caller.isAdmin,
              agentKey: input.caller.agentKey,
              rootAgentKey: input.caller.rootAgentKey,
              depth: input.caller.depth,
            },
            deadlineMs: input.deadlineMs,
            ...(input.fileAccess ? { fileAccess: input.fileAccess } : {}),
          },
          { timeoutMs: input.deadlineMs },
        )
        const outcome = response.outcome
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
          message:
            error instanceof InternalApiError
              ? `工具网关返回 ${error.status}：${error.detail}`
              : `工具网关调用失败：${error instanceof Error ? error.message : String(error)}`,
          retryable,
        } as ToolOutcome
      }
    },
  }
}
