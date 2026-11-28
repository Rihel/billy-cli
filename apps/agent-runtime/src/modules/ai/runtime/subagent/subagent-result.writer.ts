import { Inject, Injectable, Optional } from '@nestjs/common'
import { AppLogger } from '@repo/kits'
import type { AgentRuntimeEnvelope } from '../../foundation/envelope.js'
import { REMOTE_TOOL_INVOKER, type RemoteToolInvoker } from '../../tools/engine/tool.ports.js'
import { toCaller } from '../../tools/engine/tool.caller.js'
import { FileService } from '../../domain/files/file.service.js'
import { ConversationRepository } from '../conversation/conversation.repository.js'
import { subAgentResultPath } from './subagent-result.js'

/** 落盘结果：路径 + 字节数 + 行数（唤醒通知与 `wait-sub-agent` 都只回这三个值） */
export interface SubAgentResultFile {
  path: string
  bytes: number
  lines: number
}

/** 写结论是收尾动作，不该拖住唤醒：工作区正常时一次写文件远小于这个值 */
const RESULT_WRITE_TIMEOUT_MS = 30_000

/**
 * 子助手结论写入**工作区执行面**（不是运行时所在宿主的本地盘）。
 *
 * 为什么必须走执行面（2026-11-22 实测，会话 `pyao4cssrwn3qf291wh8`）：
 * - 工作区是容器 / 远程时，`bash` 与 `read-file` 都在工作区里（容器 `/workspace`）；
 * - 旧实现直接用进程内 `FileService`（本地 fs）写 `{AGENT_COMMAND_WORK_DIR}/{会话}/subagents/`，
 *   文件落在宿主上 —— 父 agent 用 `read-file` 读同一路径报 `No such file or directory`，
 *   但 `wait-sub-agent` 用本地 `stat` 又报出「有 3604 字节」，等于给模型一个假路径；
 * - `docs/design/workspace.md` §3 的硬规则：**文件与命令必须在同一个 Workspace 内**。
 *
 * 走能力网关的 `write-file`：与模型自己的文件工具同一条执行面
 * （网关 → workspace-service → 容器），零新增部署配置，并按会话的 `workspaceId` 路由。
 * 只有未接能力网关（自托管、工作区就是宿主目录）时才回落本地 `FileService`。
 */
@Injectable()
export class SubAgentResultWriter {
  constructor(
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    /** 能力网关（未配置 `TOOL_GATEWAY_URL` 时为 null） */
    @Optional()
    @Inject(REMOTE_TOOL_INVOKER)
    private readonly remote?: RemoteToolInvoker | null,
    /** 本地兜底（自托管 / 未接网关）：工作区就是宿主目录 */
    @Optional() @Inject(FileService) private readonly files?: FileService,
  ) {}

  async write(
    envelope: AgentRuntimeEnvelope,
    name: string,
    subRunId: string,
    text: string,
  ): Promise<SubAgentResultFile | null> {
    if (!text.trim()) return null
    const filePath = subAgentResultPath(name, subRunId)
    const bytes = Buffer.byteLength(text, 'utf8')
    const lines = text.split('\n').length
    const workspaceConversationId = envelope.workspaceConversationId ?? envelope.conversationId

    if (this.remote?.supports('write-file')) {
      const workspaceId = await this.workspaceIdOf(envelope, workspaceConversationId)
      const caller = toCaller(envelope)
      if (!caller) return null
      const outcome = await this.remote
        .invoke({
          toolKey: 'write-file',
          // 引擎写结论不是模型的一次工具调用：不带幂等键，避免和 `run-sub-agent` 的 callId 撞车
          toolCallId: null,
          input: { filePath, content: text },
          caller,
          workspaceConversationId,
          ...(workspaceId ? { workspaceId } : {}),
          fileAccess: envelope.fileAccess,
          deadlineMs: RESULT_WRITE_TIMEOUT_MS,
        })
        .catch((error: unknown) => ({
          ok: false as const,
          reason: 'internal' as const,
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }))
      if (outcome.ok) return { path: filePath, bytes, lines }
      this.logger.warn('ai.subagent.result_persist_failed', {
        subRunId,
        filePath,
        reason: outcome.message,
      })
      /**
       * **网关在、写失败时不回落本地**（工作区不可用 / 能力被停用 / 只读）：
       * 本地写出来的文件父 agent 依然读不到，报一个假路径比没有路径更糟。
       * 返回 null，唤醒通知退回「摘要 + 子会话」。
       */
      return null
    }

    // 未接能力网关（自托管）：工作区就是宿主目录，沿用原来的本地落盘
    const files = this.files
    if (!files) return null
    try {
      const written = await files.writeFile(
        {
          conversationId: workspaceConversationId,
          userId: envelope.triggeredBy,
          isAdmin: envelope.isAdmin,
          runId: subRunId,
          toolCallId: null,
        },
        { filePath, content: text },
      )
      return { path: filePath, bytes: written.bytes, lines: written.lines }
    } catch (error) {
      this.logger.warn('ai.subagent.result_persist_failed', {
        subRunId,
        filePath,
        error,
      })
      return null
    }
  }

  /** 会话绑定的工作区；信封没带时查会话（子会话共享根会话的工作区） */
  private async workspaceIdOf(
    envelope: AgentRuntimeEnvelope,
    workspaceConversationId: string,
  ): Promise<string | null> {
    if (envelope.workspaceId) return envelope.workspaceId
    try {
      const conversation = await this.conversations.findEntity(workspaceConversationId)
      return conversation?.workspaceId ?? null
    } catch {
      return null
    }
  }
}
