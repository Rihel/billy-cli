import type { AgentChatDto, ChatAttachmentModel } from '@repo/shared'
import { TimelineKind, TimelineRole } from '@repo/shared'
import type { ConversationEntity } from '@repo/db'
import type { AgentDefinition } from '../../domain/agents/types.js'
import type { RuntimeModel } from '../../foundation/envelope.js'
import { AGENT_MAX_STEPS } from '../../foundation/constants.js'
import type { BuiltContext } from '../context/context.service.js'
import {
  buildRuntimeContext,
  resolveSystemPrompt,
  type RuntimeContextDeps,
} from '../context/runtime-context.builder.js'
import { startFirstTurnTitle, type FirstTurnTitleDeps } from '../conversation/first-turn-title.js'
import type { FirstTurnTitle } from '../conversation/title.service.js'
import { summarizeConversation } from '../context/conversation-summarizer.js'
import type { RunRepository } from '../run/run.repository.js'
import type { TimelineRepository } from '../run/timeline.repository.js'
import type { RuntimeModelResolver } from '../model/model-resolver.js'
import type { ToolFace } from '../../engine/ports.js'
import type { SkillLoader } from '../../tools/skills/index.js'
import { MastraModelClient } from '../../engine/adapters/model-client.adapter.js'

/** 用户消息的落库载荷（没有附件时形状与历史数据逐字节一致） */
export const userMessagePayload = (input: AgentChatDto): Record<string, unknown> =>
  input.attachments && input.attachments.length > 0
    ? { text: input.message, attachments: input.attachments }
    : { text: input.message }

/** 一轮准备阶段的依赖（chat.service 已有这些实例） */
/** Mastra memory 的最小形状（thread + resource） */
export interface MemoryThreadHandle {
  thread: string
  resource: string
}

export interface PrepareTurnDeps {
  models: RuntimeModelResolver
  runs: RunRepository
  timelines: TimelineRepository
  toolFace: ToolFace
  skillLoader: SkillLoader
  titleDeps: FirstTurnTitleDeps
  runtimeContextDeps: RuntimeContextDeps
  /** 组装上下文（附件 + 记忆 + 裁剪/压缩）；保留回调，避免把 ContextService 细节再搬一份 */
  buildContext: (
    conversationId: string,
    userId: string,
    definition: AgentDefinition,
    userMessage: string,
    model: RuntimeModel,
    attachments?: readonly ChatAttachmentModel[],
    internalNotice?: string,
  ) => Promise<BuiltContext>
  /** 建（或取）Mastra memory thread */
  ensureThread: (conversationId: string, userId: string) => Promise<MemoryThreadHandle>
  /** thread 为空时用时间线回灌一份对话骨架 */
  rehydrateThread: (conversationId: string, userId: string) => Promise<unknown>
}

export interface PrepareTurnInput {
  conversation: ConversationEntity
  definition: AgentDefinition
  run: { id: string; taskId: string | null }
  userId: string
  isAdmin: boolean
  input: AgentChatDto
  /** 本轮来源（子 agent 唤醒不写用户消息、不命名） */
  origin: 'user' | 'subagent'
  /** 中止信号（流式 / 续跑有，非流式没有） */
  abortSignal?: AbortSignal
  /** 是否落用户消息（唤醒轮不落） */
  writeUserMessage: boolean
  /** 唤醒轮给模型看的内部通知 */
  internalNotice?: string
  /** 额外写进请求快照的字段（队列路径的 origin / queue / subAgent） */
  snapshotExtra?: Record<string, unknown>
  /** 唤醒轮的系统卡（子 agent 完成）：写进时间线供回看 */
  card?: Record<string, unknown> | null
}

export interface PrepareTurnResult {
  model: RuntimeModel
  modelInstance: MastraModelClient
  built: BuiltContext
  titlePromise: Promise<FirstTurnTitle | null>
}

/**
 * 一轮的**准备阶段**：模型解析 → 首轮命名 → 上下文组装（必要时压缩一次）→
 * 请求快照 → 用户消息落库 → 运行时信封 → memory thread。
 *
 * 为什么抽出来：四条入口（非流式 / 首轮流式 / 队列 / 续跑之外的三条）各自写了一遍，
 * 顺序与落库口径一旦漂移就会出现"某条路径没有输入快照"这类只有在复盘时才发现的问题。
 *
 * 续跑不走这里：它不重建上下文，直接用 durable 快照续跑。
 */
export const prepareTurn = async (
  deps: PrepareTurnDeps,
  input: PrepareTurnInput,
): Promise<PrepareTurnResult> => {
  const { conversation, definition, run, userId, isAdmin } = input

  // ① 解析本轮模型（**只能来自库里的配置**；解析不出来直接 3406/3402，不建流不烧钱）
  const model = await deps.models.resolveForRuntime(input.input.modelId ?? definition.model, {
    runId: run.id,
    conversationId: conversation.id,
    identityType: isAdmin ? 'admin' : 'user',
    identityId: userId,
  })
  const modelInstance = await MastraModelClient.create(model)
  // 首轮命名：**与主回答并行**起跑（子 agent 唤醒不命名）
  const titlePromise =
    input.origin === 'user'
      ? startFirstTurnTitle(
          deps.titleDeps,
          conversation,
          run.id,
          input.input.message,
          model,
          input.abortSignal,
        )
      : Promise.resolve(null)

  // ② 组装上下文（窗口优先用库里配的实测值；超限则先压缩一次再重新组装，只压一次）
  let built = await deps.buildContext(
    conversation.id,
    conversation.userId,
    definition,
    input.input.message,
    model,
    input.input.attachments,
    input.internalNotice,
  )
  if (built.needsCompaction && built.compactionRange) {
    // 压缩发生在建流之前（尚未 writeHead），它的模型调用不单独接 abortSignal ——
    // 失败会降级为纯裁剪（见 summarizeConversation），不会阻断这一轮
    await summarizeConversation(
      { timelines: deps.timelines, logger: deps.runtimeContextDeps.logger },
      conversation.id,
      run.id,
      built.compactionRange,
      model,
    )
    built = await deps.buildContext(
      conversation.id,
      conversation.userId,
      definition,
      input.input.message,
      model,
      input.input.attachments,
      input.internalNotice,
    )
  }

  // ③ 输入快照**在调模型之前就落库**（失败 / 超时 / 进程被杀的运行也要查得到"给了模型什么"）
  await deps.runs.saveRequestSnapshot(run.id, {
    model: model.modelRef,
    agentKey: definition.key,
    toolKeys: deps.toolFace.expand(definition.tools),
    // 技能名现算：`skills: ['*']` 在运行期展开，在线新建的技能这一轮就能出现在快照里
    skillKeys: (await deps.skillLoader.resolve(definition.skills)).map((skill) => skill.name),
    params: { maxSteps: AGENT_MAX_STEPS },
    context: built.snapshot,
    ...input.snapshotExtra,
  })

  // ④ 用户消息先落库（之后无论成败，审计上都能看到"用户问了什么"）
  if (input.writeUserMessage) {
    const now = new Date()
    await deps.timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.User,
      kind: TimelineKind.Text,
      payload: userMessagePayload(input.input),
      startedAt: now,
      finishedAt: now,
    })
  } else if (input.card) {
    // 时间线**先写系统卡**：刷新 / 回看时"父为什么突然继续了"有据可查
    const now = new Date()
    await deps.timelines.append({
      conversationId: conversation.id,
      runId: run.id,
      role: TimelineRole.System,
      kind: TimelineKind.Status,
      payload: input.card,
      startedAt: now,
      finishedAt: now,
    })
  }

  return { model, modelInstance, built, titlePromise }
}

/** 运行时信封 / memory thread 的输入 */
export interface PrepareRuntimeInput {
  conversation: ConversationEntity
  definition: AgentDefinition
  run: { id: string; taskId: string | null }
  userId: string
  isAdmin: boolean
  model: RuntimeModel
  origin: 'user' | 'subagent'
  abortSignal?: AbortSignal
  /** 本轮用户输入原文（只用于 `/技能名` 点名；续跑 / 唤醒不传） */
  userMessage?: string
}

/**
 * 运行时信封 + memory thread。
 *
 * 与 `prepareTurn` 拆开是因为队列路径要在两者之间建流（先有输出记录再解析信封），
 * 顺序不能挪：`data-run` 帧必须早于任何业务事件。
 */
export const prepareRuntime = async (
  deps: PrepareTurnDeps,
  input: PrepareRuntimeInput,
): Promise<{
  requestContext: Awaited<ReturnType<typeof buildRuntimeContext>>
  memoryThread: MemoryThreadHandle
}> => {
  const requestContext = await buildRuntimeContext(
    deps.runtimeContextDeps,
    input.conversation.id,
    input.run.id,
    input.definition,
    input.userId,
    input.model,
    {
      ...(input.run.taskId ? { taskId: input.run.taskId } : {}),
      fileAccess: input.conversation.fileAccess,
      workspaceConversationId: input.conversation.rootConversationId ?? input.conversation.id,
      ...(input.conversation.workspaceId ? { workspaceId: input.conversation.workspaceId } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      systemPrompt: await resolveSystemPrompt(
        deps.runtimeContextDeps,
        input.conversation,
        input.run.id,
        input.definition,
        input.userId,
        input.isAdmin,
      ),
      ...(input.origin === 'user' && input.userMessage ? { userMessage: input.userMessage } : {}),
      isAdmin: input.isAdmin,
    },
  )
  const memoryThread = await deps.ensureThread(input.conversation.id, input.userId)
  await deps.rehydrateThread(input.conversation.id, input.userId)
  return { requestContext, memoryThread }
}
