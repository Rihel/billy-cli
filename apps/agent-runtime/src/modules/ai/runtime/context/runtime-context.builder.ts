import { join } from 'node:path'
import type { AppLogger } from '@repo/kits'
import type { ConversationEntity } from '@repo/db'
import type { TimelineRepository } from '../run/timeline.repository.js'
import type { ToolRegistry } from '../../tools/engine/tool.registry.js'
import type { SkillLoader } from '../../tools/skills/index.js'
import type { PromptEngine } from '../../foundation/prompts/prompt.engine.js'
import type { ToolDiscoveryStore } from '../../tools/engine/tool-discovery.store.js'
import type { AgentDefinition } from '../../domain/agents/types.js'
import type { RuntimeModel, AgentRuntimeEnvelope } from '../../foundation/envelope.js'
import type { WorkspaceEnvironmentClient } from '../workspace/workspace-environment.client.js'
import type { GatewayToolCatalog } from '../model/gateway-capability-catalog.js'
import type { RemoteToolInvoker } from '../../tools/engine/tool.ports.js'
import { addCapabilityTools } from '../../tools/engine/external.tool.js'
import { buildEnvironmentData } from '../../foundation/prompts/environment.js'
import { renderAgentInstructions } from '../../domain/agents/instructions.js'
import { requestedSkillsOf, requestedSkillsSection } from '../../tools/skills/requested-skills.js'
import { skillCatalogSection } from '../../tools/skills/skill-catalog.js'
import { toRequestContext } from '../../adapters/mastra/context.adapter.js'
import { TimelineKind, TimelineRole } from '@repo/shared'

/** 运行时信封构建的依赖（chat.service 已有这些实例） */
export interface RuntimeContextDeps {
  tools: ToolRegistry
  catalog?: GatewayToolCatalog | null
  remote?: RemoteToolInvoker | null
  discovery?: ToolDiscoveryStore | null
  skills: SkillLoader
  prompts: PromptEngine
  workspace?: WorkspaceEnvironmentClient | null
  timelines: TimelineRepository
  logger: AppLogger
}

/** buildRuntimeContext 的可选项 */
export interface RuntimeContextOptions {
  abortSignal?: AbortSignal
  systemPrompt?: string
  isAdmin?: boolean
  /** 会话选的沙箱文件权限（只读 / 可写）：只影响沙箱内写权限，逃不出沙箱 */
  fileAccess?: 'read-only' | 'workspace-write'
  /** 工作区/文件归属的根会话（子会话共享父工作区） */
  workspaceConversationId?: string
  /** 本轮用户输入原文（用来识别 `/技能名` 点名；子 agent 唤醒 / 续跑没有这一项） */
  userMessage?: string
  /** 逻辑任务 id：子 agent 的 run 继承父任务 */
  taskId?: string
}

/**
 * 组装并放入**运行时信封**（`requestContext`）。
 *
 * 为什么由编排层算：`run-sub-agent` 工具需要"子 agent 能用哪些工具"，
 * 而这依赖注册机；若让工具自己注入注册机，装配会成环
 * （注册机依赖工具）。信封把这份依赖倒过来，见设计文档 §3.14.4。
 */
export const buildRuntimeContext = async (
  deps: RuntimeContextDeps,
  conversationId: string,
  parentRunId: string,
  definition: AgentDefinition,
  userId: string,
  model: RuntimeModel,
  options: RuntimeContextOptions = {},
): Promise<Awaited<ReturnType<typeof toRequestContext>>> => {
  // 子 agent 工具面 = 与主 agent **同一份**（本地 + 能力目录 code + 会话搜到的外部/MCP），
  // 再按本次身份过滤作用域；差别只有委派类（`child:'deny'` 目前也只剩子助手那一组）与
  // `ask-user-questions`（子助手没有回答通道，见 `ai.mastra.ts`）。
  const caller = {
    isAdmin: options.isAdmin ?? false,
    userId,
    rootAgentKey: definition.key,
    conversationId,
  }
  const childToolbox = new Map(await deps.tools.authorizedChildToolbox(definition.tools, caller))
  if (deps.catalog && deps.remote) {
    addCapabilityTools({
      toolbox: childToolbox,
      capabilities: await deps.catalog.capabilities(caller),
      declared: definition.tools,
      discovered: (await deps.discovery?.list(conversationId)) ?? [],
      remote: deps.remote,
      skipKeys: new Set(childToolbox.keys()),
    })
  }

  // 技能目录由 runtime 自己渲染进系统指令（§6.7.3）：只给 name + description，
  // 正文由模型用 `file-read` 读工作区里的 `.agents/<name>/SKILL.md`
  const skills = await deps.skills.resolve(definition.skills)
  // `/技能名` 点名（与可见技能求交集）：写进**这一轮**的系统指令，不进会话级快照，
  // 否则首轮快照会漏掉后续每轮各自的点名（快照按设计逐字复用）
  const requestedSkills = requestedSkillsOf(options.userMessage ?? '', skills)
  const systemPrompt = `${options.systemPrompt ?? definition.instructions}${skillCatalogSection(skills)}${requestedSkillsSection(requestedSkills)}`

  const envelope: AgentRuntimeEnvelope = {
    conversationId,
    ...(options.taskId ? { taskId: options.taskId } : {}),
    workspaceConversationId: options.workspaceConversationId ?? conversationId,
    parentRunId,
    triggeredBy: userId,
    // 身份由编排层给（控制器从鉴权上下文取）：工具作用域判定用它，**不由模型决定**
    isAdmin: options.isAdmin ?? false,
    fileAccess: options.fileAccess ?? 'workspace-write',
    depth: 0,
    agentKey: definition.key,
    // 根 agent key：子 agent 沿用父的判定（作用域按它算）
    rootAgentKey: definition.key,
    model,
    // 子 agent 的工具面 = 父 agent 的授权面 ∩ 全部 − 委派类 − child:deny
    childToolbox,
    skills,
    systemPrompt,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
  }
  // 与 `RequestContext` 的读写收在适配器里（主体不认识 Mastra 的这个词）
  return toRequestContext(envelope)
}

/**
 * 本轮**真正送进模型的系统指令全文**：基础指令 +（仅首轮的）运行环境，并**落一条快照**。
 *
 * 口径（用户拍板）：**每个会话首轮生成一次**。同一个 agent 的后续轮次逐字复用首轮那份，
 * 于是"会话进行中改了提示词模板 / 调了工具面"都不会让这个会话中途换系统提示词：
 * 前缀缓存不被打断，审计回看也确定。
 *
 * 唯一的例外是**显式换 agent**：那时按新 agent 重新生成并落一条新快照。
 */
export const resolveSystemPrompt = async (
  deps: RuntimeContextDeps,
  conversation: ConversationEntity,
  runId: string,
  definition: AgentDefinition,
  userId: string,
  isAdmin: boolean,
): Promise<string> => {
  // ★ 首轮生成一次：同一个 agent 的后续轮次**逐字复用**首轮那份（不是"重算后比对"）
  const previous = await deps.timelines.latestSystemPrompt(conversation.id)
  if (previous && previous.agentKey === definition.key) return previous.text

  const instructions = await renderAgentInstructions(definition, deps.tools, deps.catalog, {
    isAdmin,
    userId,
    conversationId: conversation.id,
  })
  const environment = await renderEnvironment(deps, conversation)
  const systemPrompt = environment ? `${instructions}\n\n${environment}` : instructions

  await deps.timelines.append({
    conversationId: conversation.id,
    runId,
    role: TimelineRole.System,
    kind: TimelineKind.System,
    payload: {
      text: systemPrompt,
      agentKey: definition.key,
      // 便于一眼看出这条快照是哪种形态（首轮那条为 true）
      environmentInjected: Boolean(environment),
    },
    finishedAt: new Date(),
  })
  return systemPrompt
}

/**
 * 会话**开局**的运行环境片段（操作系统 + 当前时间）；非首轮返回 `undefined`。
 *
 * 「首轮」= 这个会话还没有完成过任何一轮（`turnCount === 0`）。两个刻意的取舍：
 * 1. **只在首轮注入**：系统提示词是请求前缀，每轮塞一个新时间戳会让提供方的前缀缓存
 *    每轮失效；需要精确时间时模型用 `bash` 自己取。
 * 2. **渲染失败不打断问答**：环境片段是"锦上添花"，模板出问题记一条 warn 继续跑。
 */
const renderEnvironment = async (
  deps: RuntimeContextDeps,
  conversation: ConversationEntity,
): Promise<string | undefined> => {
  if (conversation.turnCount > 0) return undefined
  try {
    const workspace = await deps.workspace?.of(conversation.workspaceId)
    const sessionRoot = workspace
      ? join(workspace.root, 'conversations', conversation.rootConversationId ?? conversation.id)
      : undefined
    return deps.prompts.renderPartial(
      'partials/environment',
      buildEnvironmentData(undefined, undefined, undefined, workspace ?? undefined, sessionRoot),
    )
  } catch (error) {
    deps.logger.warn('ai.environment.render_failed', {
      conversationId: conversation.id,
      reason: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}
