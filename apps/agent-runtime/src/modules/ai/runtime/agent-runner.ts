import { Inject, Injectable, Optional } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'
import dedent from 'dedent'
import { AppLogger } from '@repo/kits'
import { RunErrorStage, RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import { AGENT_MAX_STEPS, SUB_AGENT_MAX_CONCURRENT } from '../core/constants.js'
import { createMastraAgent, toMastraModel, toMastraModelInstance } from '../mastra/agent.adapter.js'
import {
  AGENT_MEMORY,
  agentMemory as sharedAgentMemory,
  memoryHistoryOptions,
  type AgentMemory,
} from '../mastra/agent-memory.js'
import { toMastraSkills } from '../mastra/skill.adapter.js'
import { toUiStream } from '../mastra/stream.adapter.js'
import { toRequestContext } from '../mastra/context.adapter.js'
import { toMastraTools } from '../mastra/tool.adapter.js'
import { ToolRegistry } from '../core/tools/tool.registry.js'
import type { Toolbox } from '../core/tools/tools.types.js'
import { ToolCallMetaStore } from '../core/tools/tool.meta.js'
import { AgentConfig, type AgentConfig as AgentConfigValue } from '../core/config.js'
import type { AgentRuntimeEnvelope } from '../core/envelope.js'
import { toUsageRecord, totalTokensOf, usageField } from './usage.js'
import { ConversationRepository } from './conversation.repository.js'
import { MemoryExtractorService } from '../memory/memory.extractor.service.js'
import { ConversationRunQueue } from './run-queue.service.js'
import { FileService } from '../files/file.service.js'
import { subAgentResultPath } from './subagent-result.js'
import { RunRepository } from './run.repository.js'
import type { RunEntity } from '@repo/db'
import { KeyedSemaphore } from './keyed-semaphore.js'
import { StreamRecorder } from './stream-recorder.js'
import { readStreamSteps, readStreamUsage } from './stream-result.js'
import { TimelineRepository } from './timeline.repository.js'

/** 子 agent 的最终结论（**这个对象会作为 `run-sub-agent` 的工具出参交给主 agent**，故字段要自解释） */
export interface SubAgentOutcome {
  /** 子 agent 的 run id（`null` = 没跑起来，见 `reason`） */
  subRunId: string | null
  /** 子会话 id（`null` = 没建子会话；前端可据此打开子会话） */
  conversationId: string | null
  name: string
  /** `succeeded` 跑完 / `failed` 失败 / `canceled` 被停止 / `rejected` 根本没跑（配额 / 深度） */
  status: 'succeeded' | 'failed' | 'canceled' | 'rejected'
  /** 子 agent 的最终文本（失败时为空串，原因在 `error`） */
  result: string
  error: string | null
  stepCount: number
  toolCallCount: number
  usage: Record<string, unknown> | null
  durationMs: number
  /** 是否命中幂等复用（崩溃恢复重放，**没有重跑、没有重复扣费**） */
  reused?: boolean
  /** `rejected` 的原因（配额 / 深度），给模型看的话术 */
  reason?: string
}

/** 子 agent 的四个旋钮（来自 `run-sub-agent` 的工具配置；0 = 沿用部署默认） */
export interface SubAgentQuotas {
  maxPerRun?: number
  maxDepth?: number
  maxSteps?: number
  timeoutMs?: number
}

/** 发起一个子 agent 的入参（工具层解析完后交过来） */
export interface SubAgentRequest {
  /** 子助手短标识（主 agent 起的名字） */
  name: string
  /** **主 agent 现场撰写的系统提示词**（原样使用，我们不追加也不覆盖） */
  systemPrompt: string
  /** 交给子 agent 的任务（作为它的第一条用户消息） */
  task: string
  /** 父那次工具调用的 id（幂等键；拿不到时为 null） */
  toolCallId: string | null
  /** 运行时信封（会话 / 父 run / 深度 / 子工具面） */
  envelope: AgentRuntimeEnvelope
  /** 把实时明细写进父流（非流式调用时为 undefined） */
  writer?: SubAgentWriter
  /** 四个旋钮（来自工具配置；缺省走部署默认） */
  quotas?: SubAgentQuotas
  /** 异步模式：创建成功即回调，子 agent 在后台继续跑 */
  async?: boolean
  /** 创建成功 / 被拒绝时的回调（异步工具用它返回 task 信息） */
  onSpawned?: (info: { subAgentId: string; subRunId: string } | null, error?: string) => void
}

/** Mastra 的工具输出流（`ToolStream` 的最小面；只用到 `write`） */
export interface SubAgentWriter {
  write: (chunk: unknown) => Promise<unknown> | unknown
}

/** UI Message Stream 片段的最小结构（只取我们关心的字段） */
interface ChunkLike {
  type?: string
  id?: string
  delta?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  errorText?: string
}

const DEFAULT_MAX_PER_RUN = 4
const DEFAULT_MAX_DEPTH = 1
/**
 * 等「子会话 + 子 run 建好」的上限（**不是子 agent 的寿命**）。
 *
 * 创建路径里有并发闸门（`SUB_AGENT_MAX_CONCURRENT`），第 N 个要排队等前面跑完 ——
 * 排队时间随子任务时长变化，30 秒必然误报（2026-11-15 实测排了 85 秒）。
 * 到点**先回查再判失败**，见 `spawnSubAgent`。
 */
const DEFAULT_SUB_AGENT_SPAWN_TIMEOUT_MS = 90_000

/** 父 run 还活着的状态集合：父已终态时，异步回调不该再往它的时间线上写事件 */
const ACTIVE_RUN_STATUSES = new Set<string>([
  RunStatus.Pending,
  RunStatus.Running,
  RunStatus.Suspended,
])

/** 子 run 的终态集合：用来算「同一批还有谁在跑」（唤醒通知里的进度） */
const TERMINAL_RUN_STATUSES = new Set<string>([
  RunStatus.Succeeded,
  RunStatus.Failed,
  RunStatus.Canceled,
  RunStatus.Interrupted,
])

/**
 * 给子 agent 的提示词**追加一段固定的能力段**（设计 §5.10 第 4 条，待拍板项按"追加"实现）。
 *
 * 为什么追加：主 agent 写的那份是"任务指令"，但子 agent 的上下文里**没有我们的《工具》模板段**
 * （它的提示词由主 agent 现写），于是它不知道自己手上有什么、也不知道"不能再造子助手"这条边界。
 * 这段尾巴不覆盖主 agent 的原话，只补三件事：工具清单、边界、交付要求。
 */
const withCapabilityTail = (writtenByParent: string, toolbox: Toolbox): string => {
  const tools = [...toolbox.keys()]
  const toolList = tools.length > 0 ? tools.map((key) => `\`${key}\``).join('、') : '（无）'
  return dedent`
    ${writtenByParent.trim()}

    # 你的能力与边界（系统补充，不要与上面的要求冲突）
    - 你可以调用的工具：${toolList}；
    - 你**不能**创建子助手，也不要假装有清单外的工具；需要别的能力就把结论交回主 agent；
    - 你**不能**向用户提问，也不能挂起等回答（没有问答工具）；缺信息或需要拍板时，把问题连同已知前提写清楚，和结论一起交回主 agent；
    - 你看到的上下文只有上面的任务说明，主 agent 与用户的对话你**看不到**；
    - 交付要求：给出结论 + 关键依据（口径、命令、文件路径），不要转贴大段原始输出。
  `
}

/** 子 agent 名称 → 入库用的 agent key（`sub:<slug>`，列宽 64） */
const toSubAgentKey = (name: string): string =>
  `sub:${name.trim().replace(/\s+/g, '-').slice(0, 48)}`

/**
 * **子 agent 执行器**：动态创建并跑一个子 agent，把它的一切落库。
 *
 * 分工（`docs/design/ai-agent.md` §3.14）：
 * - 子 agent 是**独立 run**（`parent_run_id` / `depth` / `tool_call_id`），与父同会话；
 * - 它的消息、推理、工具调用与结果、每步用量走**与主 run 同一个录制器**（细节不缩水）；
 * - 主 agent 现场写的 `system_prompt` 与 `task` **全量落 `runs.request_snapshot`**
 *   ——"子 agent 为什么这么干"的唯一证据；
 * - 实时明细经工具上下文的 `writer` 写成 `data-sub-agent*` 块，进的是**父的那一条流**；
 * - 幂等：同一 `(parent_run_id, tool_call_id)` 已成功过 → 直接复用结论（不重跑、不重复扣费）。
 *
 * 它是普通 bean（**不是**工具组）：工具组负责"把能力交出去"，本类负责"怎么跑"。
 */
@Injectable()
export class AgentRunner {
  constructor(
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ToolCallMetaStore) private readonly toolMetas: ToolCallMetaStore,
    /**
     * ⚠️ 注册机**只能惰性取**（`ModuleRef`），不能进构造器。
     *
     * 原因：`ToolRegistry → AGENT_TOOL_GROUPS → RunSubAgentTool → AgentRunner`，若这里再注入注册机就成了环；
     * 而 Nest 对**工厂型 provider** 的环**不报错、直接静默死锁**（实测：进程 CPU 0%，永远停在启动中）。
     * 这里只在真正要写时间线时取一次，那时容器早就绪了。
     */
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    /** 子会话自己的 memory thread（测试/无 Redis 场景不传，回落进程内实现） */
    @Optional() @Inject(AGENT_MEMORY) private readonly memory?: AgentMemory,
    /** 子会话轮后抽取（可选；失败只记日志，不影响工具结论） */
    @Optional()
    @Inject(MemoryExtractorService)
    private readonly memoryExtractor?: MemoryExtractorService,
    /** 异步子 agent 完成 → 父会话唤醒队列（测试 / 未装配时跳过） */
    @Optional()
    @Inject(ConversationRunQueue)
    private readonly runQueue?: ConversationRunQueue,
    /**
     * 子助手结论落工作区（写入失败不影响主链路：唤醒通知会退回「摘要 + 子会话」）。
     * 可选注入，测试栈不装文件服务时跳过。
     */
    @Optional()
    @Inject(FileService)
    private readonly files?: FileService,
  ) {}

  /** 子 agent 并发闸门（按父 run 计）：同一轮最多同时跑 `SUB_AGENT_MAX_CONCURRENT` 个 */
  private readonly subAgentSlots = new KeyedSemaphore(SUB_AGENT_MAX_CONCURRENT)

  /** 父 run → "配额判定 + 建子 run"队列：并发的 `count → create` 不能交错 */
  private readonly subAgentAdmissions = new Map<string, Promise<unknown>>()
  /** toolCallId → 工具名：输出 chunk 常不带 toolName，靠调用块补齐 */
  private readonly toolNames = new Map<string, string>()

  /** 把"配额判定 + 建子 run"按父 run 串行化（与 `PlannerStore` 的同一手法） */
  private enqueueAdmission<T>(parentRunId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.subAgentAdmissions.get(parentRunId) ?? Promise.resolve()
    const run = previous.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.subAgentAdmissions.set(parentRunId, tail)
    void tail.then(() => {
      if (this.subAgentAdmissions.get(parentRunId) === tail) {
        this.subAgentAdmissions.delete(parentRunId)
      }
    })
    return run
  }

  /** 惰性取注册机（用于把"模型编出来的工具名"标成 `unknown-tool`）；取不到就退化为"不判定" */
  private knownToolPredicate(): ((toolKey: string) => boolean) | undefined {
    try {
      const registry = this.moduleRef.get(ToolRegistry, { strict: false })
      return (toolKey: string) => Boolean(registry.get(toolKey))
    } catch {
      return undefined
    }
  }

  /** 跑一个子 agent（工具 `run-sub-agent` 的唯一入口；**不抛业务异常**，失败作为工具结论返回） */
  async runSubAgent(request: SubAgentRequest): Promise<SubAgentOutcome> {
    const { envelope } = request
    const startedAt = Date.now()

    // ① 深度守卫（当前工具面已保证为 1：子 agent 拿不到委派类工具，这里是第二道闸）
    const quotas = request.quotas ?? {}
    const maxDepth = quotas.maxDepth || this.config.subAgentMaxDepth || DEFAULT_MAX_DEPTH
    if (envelope.depth + 1 > maxDepth) {
      return this.rejected(request, startedAt, '子助手不能再创建子助手（已达深度上限）')
    }

    // ② 幂等 / 中断恢复：同一个 toolCallId 只对应一个子 run
    let interrupted: RunEntity | undefined
    if (request.toolCallId) {
      const existing = await this.runs.findChildByToolCall(envelope.parentRunId, request.toolCallId)
      if (existing) {
        if (existing.status === RunStatus.Succeeded) {
          const text = (await this.timelines.lastTextOfRun(existing.id)) ?? ''
          this.logger.log('ai.subagent.reused', {
            parentRunId: envelope.parentRunId,
            subRunId: existing.id,
            toolCallId: request.toolCallId,
          })
          await this.writeState(request, existing.id, { status: existing.status, result: text })
          request.onSpawned?.({ subAgentId: existing.conversationId, subRunId: existing.id })
          return {
            subRunId: existing.id,
            conversationId: existing.conversationId,
            name: request.name,
            status: 'succeeded',
            result: text,
            error: null,
            stepCount: existing.stepCount,
            toolCallCount: existing.toolCallCount,
            usage: existing.usage,
            durationMs: existing.durationMs ?? 0,
            reused: true,
          }
        }
        // 服务重启后子 run 被标 interrupted；复用同一行原地重启，避免撞 (parent, toolCallId) 唯一键
        if (existing.status === RunStatus.Interrupted) {
          interrupted = existing
        } else {
          return this.rejected(
            request,
            startedAt,
            `子助手 ${existing.id} 当前状态是 ${existing.status}，不能重复启动；如确需继续，请重新委派`,
          )
        }
      }
    }

    /**
     * ③ 并发闸门：同一父 run 最多同时跑 `SUB_AGENT_MAX_CONCURRENT` 个子 agent。
     *
     * 限的是"同时跑着的子 run 数"，不是总数（总数仍由工具配置的 `maxPerRun` 管）。
     * 槽位在子 agent 整个生命周期里占着，成功 / 失败 / 取消都从下面的 `finally` 释放；
     * 第 4 个会在这里排队，等前面任意一个跑完再开始。
     */
    const parentRunId = envelope.parentRunId
    await this.subAgentSlots.acquire(parentRunId)
    try {
      if (envelope.abortSignal?.aborted) {
        return this.rejected(request, startedAt, '这一轮已停止，子助手不再启动')
      }
      /**
       * 排队期间父 run 可能**已经结束**（异步子 agent + 并发闸门的正常结果）。
       * 这时再建子会话只会留下一个没人收结果的孤儿，父时间线也已经封板 —— 直接不启动。
       *
       * 只对**异步创建路径**（`spawnSubAgent`）生效：中断恢复（`interrupted`）与
       * 崩溃重放的直接调用本来就要在父 run 收尾后继续，不能拦。
       */
      if (request.async === true && !interrupted) {
        const parentRun = await this.runs.findEntity(parentRunId)
        if (!parentRun || !ACTIVE_RUN_STATUSES.has(parentRun.status)) {
          return this.rejected(request, startedAt, '父这一轮已结束，子助手不再启动')
        }
      }
      return await this.runAdmittedSubAgent(request, startedAt, interrupted)
    } finally {
      this.subAgentSlots.release(parentRunId)
    }
  }

  /**
   * 异步创建子 agent：等到子会话/子 run 建好就返回，执行在后台继续。
   *
   * 这是工具层切换到异步的唯一入口；创建失败/配额不足通过 reject 交给工具。
   */
  async spawnSubAgent(request: SubAgentRequest): Promise<{ subAgentId: string; subRunId: string }> {
    /**
     * 「等建好」的 Promise：到点**先回查**，查不到才判失败。
     *
     * 为什么不能直接 reject：`runSubAgent` 是异步启动的，超时只让这个 Promise 失败，
     * **不会取消底层创建**。直接报失败会出现「工具说超时、子会话其实已建好并跑完」的分裂状态，
     * 父模型据此重做一遍（2026-11-15 实测：第 4 个子助手报超时，85 秒后照样建好跑完）。
     */
    const waitMs = DEFAULT_SUB_AGENT_SPAWN_TIMEOUT_MS
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.recoverSpawnedChild(request)
          .then((existing) => {
            if (!existing) {
              reject(
                new Error(
                  '创建子 agent 超时（可能仍在并发排队；**不要重复创建**，稍后用 sub-agent-list 查看状态）',
                ),
              )
              return
            }
            this.logger.warn('ai.subagent.spawn_timeout_recovered', {
              parentRunId: request.envelope.parentRunId,
              subRunId: existing.id,
              toolCallId: request.toolCallId,
            })
            resolve({ subAgentId: existing.conversationId, subRunId: existing.id })
          })
          .catch((error: unknown) => {
            reject(error instanceof Error ? error : new Error(String(error)))
          })
      }, waitMs)
      void this.runSubAgent({
        ...request,
        async: true,
        onSpawned: (info, error) => {
          clearTimeout(timer)
          if (info) resolve(info)
          else reject(new Error(error ?? '子 agent 创建失败'))
        },
      }).catch((error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /**
   * 创建超时后的回查：同一个 `toolCallId` 是否已经建出子 run。
   *
   * 幂等键就是 `runs (parent_run_id, tool_call_id)` 唯一索引 —— 与 `runSubAgent` 的复用判定同一口径。
   */
  private async recoverSpawnedChild(request: SubAgentRequest): Promise<RunEntity | null> {
    if (!request.toolCallId) return null
    return await this.runs.findChildByToolCall(request.envelope.parentRunId, request.toolCallId)
  }

  /**
   * 已拿到并发槽位的子 agent：配额判定 → 建子 run → 跑完 → 收尾。
   *
   * 单独一个方法，是为了让槽位释放只有一个出口（`runSubAgent` 的 `finally`）；
   * 配额判定与建子 run 走同一父 run 的**串行队列** —— 子 agent 并行后，两个调用同时
   * `count → create` 会一起看到"还差一个"，一起越过上限。
   */
  private async runAdmittedSubAgent(
    request: SubAgentRequest,
    startedAt: number,
    interrupted?: RunEntity,
  ): Promise<SubAgentOutcome> {
    const { envelope } = request
    const quotas = request.quotas ?? {}
    const maxPerRun = quotas.maxPerRun || this.config.subAgentMaxPerRun || DEFAULT_MAX_PER_RUN

    const parent = await this.conversations.findEntity(envelope.conversationId)
    if (!parent) {
      return this.rejected(request, startedAt, '父会话不存在，无法创建子会话')
    }

    /**
     * 子 agent **最终**的系统指令 = 主 agent 现写的那份 + 能力边界尾巴。
     *
     * 只依赖信封（工具面），所以子会话一建好就能落库；同一份字符串既写进子会话的系统指令快照，
     * 又交给 `createMastraAgent` —— 「面板/审计看到的那份」与「我们交给运行时的那份」是同一个值，
     * 不靠两处各拼一遍（那正是漂移的来源）。
     * **不是**模型最终收到的 system：Mastra 在请求侧还会追加 `<available_skills>` 技能目录段
     * （2026-11-15 实测，主会话同样如此），那一段不在快照里。
     */
    const childInstructions = withCapabilityTail(request.systemPrompt, envelope.childToolbox)

    let child: { id: string }
    let agentKey: string
    let childConversationId = envelope.conversationId
    if (interrupted) {
      const restarted = await this.runs.restartChild(interrupted.id)
      if (!restarted) {
        return this.rejected(
          request,
          startedAt,
          `子助手 ${interrupted.id} 的状态已被其他执行体改动，不能重复启动`,
        )
      }
      child = interrupted
      agentKey = interrupted.agentKey
      childConversationId = interrupted.conversationId
      await this.timelines.append({
        conversationId: childConversationId,
        runId: child.id,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: {
          status: RunStatus.Running,
          stage: RunErrorStage.Recovery,
          reason: 'process_restarted',
          operator: 'system',
        },
        finishedAt: new Date(),
      })
      this.logger.warn('ai.subagent.restarted', {
        parentRunId: envelope.parentRunId,
        subRunId: child.id,
        toolCallId: request.toolCallId,
      })
    } else {
      let admitted:
        | { admitted: false; existingChildren: number }
        | { admitted: true; child: { id: string }; agentKey: string; conversationId: string }
      try {
        admitted = await this.enqueueAdmission(envelope.parentRunId, async () => {
          const existingChildren = await this.runs.countChildren(envelope.parentRunId)
          if (existingChildren >= maxPerRun) {
            return { admitted: false as const, existingChildren }
          }
          // 子 agent 现在是**子会话**：先建/复用子会话，再建挂在它下面的子 run
          const nextAgentKey = toSubAgentKey(request.name)
          const childConversation = await this.conversations.ensureSubagent({
            parent,
            name: request.name,
            agentKey: nextAgentKey,
            depth: envelope.depth + 1,
            originRunId: envelope.parentRunId,
            originToolCallId: request.toolCallId,
          })
          const created = await this.runs.create({
            conversationId: childConversation.id,
            agentKey: nextAgentKey,
            status: RunStatus.Pending,
            triggeredBy: envelope.triggeredBy,
            parentRunId: envelope.parentRunId,
            depth: envelope.depth + 1,
            toolCallId: request.toolCallId,
          })
          return {
            admitted: true as const,
            child: created,
            agentKey: nextAgentKey,
            conversationId: childConversation.id,
          }
        })
      } catch (error) {
        return this.rejected(
          request,
          startedAt,
          `创建子会话失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }

      if (!admitted.admitted) {
        return this.rejected(
          request,
          startedAt,
          `本次已创建 ${admitted.existingChildren} 个子助手，达到上限（${maxPerRun}），请自己完成剩余工作`,
        )
      }

      child = admitted.child
      agentKey = admitted.agentKey
      childConversationId = admitted.conversationId
      await this.runs.markRunning(child.id)
      // 动态提示词与任务**全量落库**（不裁剪）：这是子 agent 行为的唯一证据链
      await this.runs.saveRequestSnapshot(child.id, {
        kind: 'subagent',
        name: request.name,
        systemPrompt: request.systemPrompt,
        task: request.task,
        parentRunId: envelope.parentRunId,
        depth: envelope.depth + 1,
        toolKey: 'run-sub-agent',
      })
      const now = new Date()
      /**
       * 子会话的**系统指令快照**（与主会话同一套机制：时间线 `kind=system` 一行，后到者为准）。
       *
       * 为什么必须落这一行：右栏「系统指令」与审计页都按"这个会话实际送进模型的那份"取数
       * （`latestSystemPrompt`）。子 agent 的提示词是主 agent 现写的，原先只在
       * `runs.request_snapshot` 里存了**原稿**（不含上面那段能力边界），于是面板既看不到它、
       * 子会话页还会拿 `sub:<名字>` 去查 agent 目录报 3303。
       *
       * 顺序刻意放在任务行**之前**：审计页按 seq 看时间线时，先"它被要求怎么写"、再"交给它什么"。
       *
       * 只在新创建时写：中断重启用的是同一份 `system_prompt`（快照已在首跑落过），
       * 重写只会多一条同文本的行。真漏了（崩溃发生在落快照与建 run 之间）也只是退化成
       * "没有快照、回主 agent 原稿"，不会说错话。
       */
      await this.timelines.append({
        conversationId: childConversationId,
        runId: child.id,
        role: TimelineRole.System,
        kind: TimelineKind.System,
        payload: {
          text: childInstructions,
          agentKey,
          // 子 agent 没有"首轮运行环境"这一段；标 false 以免被当成主会话的形态
          environmentInjected: false,
          subagent: true,
        },
        finishedAt: now,
      })
      await this.timelines.append({
        conversationId: childConversationId,
        runId: child.id,
        role: TimelineRole.User,
        kind: TimelineKind.Text,
        payload: { text: request.task },
        startedAt: now,
        finishedAt: now,
      })
    }
    request.onSpawned?.({ subAgentId: childConversationId, subRunId: child.id })
    await this.writeState(request, child.id, { status: RunStatus.Running, task: request.task })

    const recorder = new StreamRecorder(
      this.timelines,
      { conversationId: childConversationId, runId: child.id },
      {
        metas: this.toolMetas,
        ...(this.knownToolPredicate()
          ? { isKnownTool: this.knownToolPredicate() as (toolKey: string) => boolean }
          : {}),
      },
    )
    /**
     * 子 agent 的墙钟上限：工具配额 → 子 agent 配置 → 单轮上限，**都为 0 = 不限制**。
     *
     * 别把 0 交给 `setTimeout`（那等于立即超时）；心跳照跳，看门狗仍能识别"进程没了"。
     */
    const timeoutMs = quotas.timeoutMs || this.config.subAgentTimeoutMs || this.config.runTimeoutMs
    const timeoutController = new AbortController()
    const timeoutTimer =
      timeoutMs > 0 ? setTimeout(() => timeoutController.abort(), timeoutMs) : undefined
    const signals = [timeoutController.signal]
    if (envelope.abortSignal) signals.push(envelope.abortSignal)
    const abortSignal = AbortSignal.any(signals)
    const heartbeat = setInterval(() => {
      void this.runs.touchHeartbeat(child.id).catch(() => undefined)
    }, 1_000)

    let text = ''
    try {
      // 子 agent **继承父这一轮的模型**（信封里带着）：不单独选模型，也就不会出现"父子用了两个模型"
      const model = envelope.model
      /**
       * 子 agent 的信封：**继承父的**，只改这几项。
       *
       * 为什么必须传下去（设计 §5.10）：网关要判身份 / 作用域 / 限流，审计要写会话与发起人；
       * 早先子 agent 那轮没有信封，规划工具（`plan-*`）每次调用都白烧一步。
       */
      const childEnvelope: AgentRuntimeEnvelope = {
        ...envelope,
        conversationId: childConversationId,
        workspaceConversationId: envelope.workspaceConversationId ?? envelope.conversationId,
        depth: envelope.depth + 1,
        agentKey,
        // 作用域仍按**根** agent 判（子 agent 沿用父的判定）
        rootAgentKey: envelope.rootAgentKey,
        // 子 agent 的工具面 / 技能面：与父同一个口径（编排层在装配信封时算好）
        childToolbox: envelope.childToolbox,
      }
      // 子会话 = 独立会话：自己的短期 thread（不继承父会话的消息），resource 仍归父用户。
      // 子 agent 之前不带 memory，`resume` / 重试时只剩本次任务；补上 thread 才能续上它自己的前文。
      const memory = this.memory ?? sharedAgentMemory
      if (!(await memory.getThreadById({ threadId: childConversationId }))) {
        await memory.createThread({
          threadId: childConversationId,
          resourceId: parent.userId,
          title: `${request.name}（子会话）`,
        })
      }
      const agent = createMastraAgent({
        // 临时实例：跑完即弃，**不注册进 Mastra**（否则会污染 agent 清单、且同名会冲突）
        id: `${agentKey}#${child.id}`,
        name: request.name,
        // **完全用主 agent 写的提示词** + 我们追加的一段能力尾巴（工具清单 / 边界 / 交付要求）
        instructions: childInstructions,
        model: () => toMastraModel(model),
        tools: toMastraTools(envelope.childToolbox, this.logger),
        skills: toMastraSkills(envelope.skills),
        memory,
      })

      const output = await agent.stream([{ role: 'user', content: request.task }] as never, {
        maxSteps: quotas.maxSteps || this.config.subAgentMaxSteps || AGENT_MAX_STEPS,
        abortSignal,
        /**
         * 显式传模型实例：Agent 上挂的是动态 model，而 Mastra 在那条路径上会把多模态 content
         * 压平成纯字符串（图片会被静默丢掉，见 `toMastraModelInstance` 的注释）。
         * 子 agent 这一轮目前只有文本任务，但同一条路径不该有第二种行为 —— 一旦将来给它带图就现形。
         */
        model: (await toMastraModelInstance(model)).instance as never,
        // 信封传下去：子 agent 那一轮的工具调用因此也能过网关的权限与审计
        requestContext: toRequestContext(childEnvelope),
        memory: {
          thread: childConversationId,
          resource: parent.userId,
          options: memoryHistoryOptions(model.contextWindow ?? 32_000),
        },
      })
      const uiStream = toUiStream(output)

      const reader = (uiStream as unknown as ReadableStream<ChunkLike>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value
        await recorder.consume(chunk)
        const delta = this.toDelta(chunk)
        if (delta) {
          /**
           * **结论正文只收 `text`**：推理是过程，时间线与实时流各自存一份，
           * 不能拼进 `text` —— 它同时是落盘结论、唤醒 payload 与卡片摘要的来源。
           * 踩过（2026-11-15）：子助手结论文件前 101 行全是 CoT，父 agent `read-file`
           * 读结论时把整段思考读进自己的上下文，白烧 token 还干扰判断。
           */
          if (delta.kind === 'text') text += delta.text
          await this.writeDelta(request, child.id, delta.kind, delta.text)
        }
        const event = this.toEvent(chunk)
        if (event) await this.writeState(request, child.id, { event })
      }

      // 被中止（用户停止 / 超时）：Mastra 会正常返回，必须自己判定这不是成功
      if (abortSignal.aborted) {
        await recorder.flushPending()
        const canceled = envelope.abortSignal?.aborted ?? false
        return await this.finish(
          request,
          child.id,
          canceled ? RunStatus.Canceled : RunStatus.Failed,
          text,
          startedAt,
          recorder,
          output,
          canceled ? null : '子助手超时（服务端判定）',
          childConversationId,
        )
      }

      await recorder.flushPending()
      return await this.finish(
        request,
        child.id,
        RunStatus.Succeeded,
        text,
        startedAt,
        recorder,
        output,
        null,
        childConversationId,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error('ai.subagent.failed', {
        parentRunId: envelope.parentRunId,
        subRunId: child.id,
        reason,
      })
      return await this.finish(
        request,
        child.id,
        envelope.abortSignal?.aborted ? RunStatus.Canceled : RunStatus.Failed,
        text,
        startedAt,
        recorder,
        null,
        reason,
        childConversationId,
      )
    } finally {
      clearInterval(heartbeat)
      if (timeoutTimer) clearTimeout(timeoutTimer)
    }
  }

  /** 收尾：终态 + 消耗 + 统计 + 实时状态，并把结论交给主 agent */
  /**
   * 子助手结论写入工作区（`subagents/<名字>-<subRunId>.md`）。
   *
   * 返回的是**相对路径**（工作区根），直接给模型用 `read-file` 读；写失败返回 null。
   */
  private async persistResultFile(
    request: SubAgentRequest,
    subRunId: string,
    text: string,
  ): Promise<{ path: string; bytes: number; lines: number } | null> {
    const files = this.files
    if (!files || !text.trim()) return null
    const filePath = subAgentResultPath(request.name, subRunId)
    try {
      const written = await files.writeFile(
        {
          // 子会话共享父会话工作区：落到根会话，父模型与用户都能看见
          conversationId:
            request.envelope.workspaceConversationId ?? request.envelope.conversationId,
          userId: request.envelope.triggeredBy,
          isAdmin: request.envelope.isAdmin,
          runId: subRunId,
          toolCallId: request.toolCallId,
        },
        { filePath, content: text },
      )
      return { path: filePath, bytes: written.bytes, lines: written.lines }
    } catch (error) {
      this.logger.warn('ai.subagent.result_persist_failed', { subRunId, filePath, error })
      return null
    }
  }

  /**
   * 子助手**每完成一个就唤醒父一次**（增量推进），通知里带同一批的进度。
   *
   * 为什么不做批次聚合：父 agent 拿到第一个结果就能开始推进，不必等最慢的那个；
   * 而「还有谁在跑」由引擎算好写进通知 —— 父 agent 不需要自己数，也不会误以为「都完了」。
   * 识别语义由通知文案承担（`chat.service` 的 `wakeNoticeText`），不靠模型猜。
   */
  private async enqueueSubAgentWake(input: {
    request: SubAgentRequest
    subRunId: string
    conversationId: string
    status: string
    text: string
    error: string | null
    resultPath: string | null
    resultBytes: number | null
    resultLines: number | null
  }): Promise<void> {
    const runQueue = this.runQueue
    if (!runQueue) return
    /**
     * 结果已经被父 agent 拿走（`wait-sub-agent` 消费过）→ **不再唤醒**。
     *
     * 为什么入队端也要查：`runs.finish` 把状态翻成终态在前，落结论文件、回写用量、入队在后，
     * 中间那段空档里父的 `wait-sub-agent` 已经能看到"已完成"并把结果拿走 ——
     * 只靠 `consumeByDedupe`（只对已有的 `queued` 行生效）会漏掉这一笔，
     * 于是父 run 结束后又起一轮"延迟到达"的唤醒（2026-11-15 实测：一次多烧 9.2 万 token）。
     */
    if (await runQueue.isConsumed(input.subRunId)) {
      this.logger.log('ai.subagent.wake_skipped_consumed', {
        parentRunId: input.request.envelope.parentRunId,
        subRunId: input.subRunId,
      })
      return
    }
    const parentRunId = input.request.envelope.parentRunId
    // 同批进度：total / 已完成 / 仍在跑的名字（刚 finish 的这个已进入终态，算「已完成」）
    let progress: { total: number; completed: number; pending: string[] } | undefined
    try {
      const siblings = await this.runs.listChildren(parentRunId)
      progress = {
        total: siblings.length,
        completed: siblings.filter((sibling) => TERMINAL_RUN_STATUSES.has(sibling.status)).length,
        pending: siblings
          .filter((sibling) => !TERMINAL_RUN_STATUSES.has(sibling.status))
          .map((sibling) => sibling.agentKey.replace(/^sub:/, '')),
      }
    } catch (error) {
      // 进度只是「让父 agent 少猜」的锦上添花：查不到就不带，唤醒本身不能因此失败
      this.logger.warn('ai.subagent.progress_unavailable', { subRunId: input.subRunId, error })
    }

    await runQueue.enqueue({
      conversationId: input.request.envelope.conversationId,
      source: 'subagent',
      dedupeKey: input.subRunId,
      payload: {
        subAgentId: input.conversationId,
        subRunId: input.subRunId,
        name: input.request.name,
        status: input.status,
        result: input.text,
        error: input.error,
        ...(input.resultPath
          ? {
              resultPath: input.resultPath,
              ...(input.resultBytes !== null ? { resultBytes: input.resultBytes } : {}),
              ...(input.resultLines !== null ? { resultLines: input.resultLines } : {}),
            }
          : {}),
        // 唤醒 run 的身份口径随父：admin 的 skill-* 工具在唤醒那一轮不能凭空消失
        isAdmin: input.request.envelope.isAdmin,
        ...(progress ? { progress } : {}),
      },
    })
  }

  private async finish(
    request: SubAgentRequest,
    subRunId: string,
    status: string,
    text: string,
    startedAt: number,
    recorder: StreamRecorder,
    output: unknown,
    error: string | null,
    conversationId: string,
  ): Promise<SubAgentOutcome> {
    // 步级用量只有读完流才知道；`output` 为 null（抛错路径）时只用录制器已知的部分。
    // **必须走 stream-result 的读取口径**：durable 下 `agent.stream()` 返回的是包装对象
    // （`{ output, fullStream, … }`），直接读 `output.steps` 拿到 undefined（踩过，见 stream-result.ts）
    const steps = output ? ((await readStreamSteps(output)) as unknown as never[]) : []
    const usage = output ? toUsageRecord(await readStreamUsage(output)) : null
    const persisted = await recorder.finish(steps)
    const durationMs = Date.now() - startedAt
    await this.runs.finish(subRunId, {
      status,
      usage,
      stepCount: steps.length,
      toolCallCount: persisted.toolCallCount,
      durationMs,
      ...(error
        ? {
            errorCode: null,
            errorStage: RunErrorStage.Subagent,
            errorMessage: error,
            errorDetail: { raw: error },
          }
        : {}),
    })
    if (error) {
      await this.timelines.append({
        conversationId,
        runId: subRunId,
        role: TimelineRole.System,
        kind: TimelineKind.Error,
        payload: { message: error, stage: RunErrorStage.Subagent },
        finishedAt: new Date(),
      })
    }
    /**
     * 子助手结论落工作区：`subagents/<名字>-<subRunId>.md`。
     *
     * 父模型与用户都不该从"几万字塞进上下文"里拿结论 —— 唤醒通知只带 path + 摘要，
     * 需要全文用 `read-file` 按行分页读（用户也能在文件树里直接看）。
     * 写失败只 warn：唤醒通知会退回「摘要 + 子会话」，主链路不受影响。
     */
    const resultFile = await this.persistResultFile(request, subRunId, text)

    /**
     * 子 run 的用量补记（父 run 收尾汇总之外的兜底，见 `ConversationRepository.addTokens`）。
     *
     * - 子会话：总是记自己那一份（子会话详情要能看消耗）；
     * - 根会话：**只在父 run 已终态时**补记 —— 父还在跑时由父收尾汇总 `usage.subAgents`，
     *   两边都记会双计。异步子 agent 下「父先收尾、子后完成」是常态，不补这一笔会话总量就会漏。
     */
    if (usage) {
      const tokens = totalTokensOf(usage)
      if (tokens > 0) {
        await this.conversations.addTokens(conversationId, tokens)
        const parentRun = await this.runs.findEntity(request.envelope.parentRunId)
        if (!parentRun || !ACTIVE_RUN_STATUSES.has(parentRun.status)) {
          const rootConversationId =
            request.envelope.workspaceConversationId ?? parentRun?.conversationId
          if (rootConversationId && rootConversationId !== conversationId) {
            await this.conversations.addTokens(rootConversationId, tokens)
            this.logger.log('ai.usage.subagent_late_rollup', {
              parentRunId: request.envelope.parentRunId,
              subRunId,
              conversationId: rootConversationId,
              tokens,
            })
          }
        }
      }
    }
    const outcome: SubAgentOutcome = {
      subRunId,
      conversationId,
      name: request.name,
      status:
        status === RunStatus.Succeeded
          ? 'succeeded'
          : status === RunStatus.Canceled
            ? 'canceled'
            : 'failed',
      result: text,
      error,
      stepCount: steps.length,
      toolCallCount: persisted.toolCallCount,
      usage,
      durationMs,
    }
    await this.writeState(request, subRunId, {
      status: outcome.status,
      stepCount: outcome.stepCount,
      toolCallCount: outcome.toolCallCount,
      usage,
      durationMs,
      result: text,
      error,
    })
    this.logger.log('ai.subagent.finished', {
      parentRunId: request.envelope.parentRunId,
      subRunId,
      name: request.name,
      status: outcome.status,
      durationMs,
      tokenTotal: usage ? usageField(usage, 'totalTokens') : null,
    })
    if (request.async && this.runQueue && status !== RunStatus.Canceled) {
      void this.enqueueSubAgentWake({
        request,
        subRunId,
        conversationId,
        status: outcome.status,
        text,
        error,
        resultPath: resultFile?.path ?? null,
        resultBytes: resultFile?.bytes ?? null,
        resultLines: resultFile?.lines ?? null,
      }).catch((error: unknown) => {
        this.logger.error('ai.subagent.enqueue_failed', { subRunId, error })
      })
    }
    if (status === RunStatus.Succeeded && this.memoryExtractor && request.envelope.triggeredBy) {
      // 子会话也有自己的记忆抽取（不阻塞工具结论；失败静默，与主会话同一口径）
      void this.memoryExtractor
        .maybeExtract({
          conversationId,
          runId: subRunId,
          userId: request.envelope.triggeredBy,
          agentKey: request.envelope.agentKey,
          userMessage: request.task,
          turnCount: 1,
          model: request.envelope.model,
        })
        .catch((error: unknown) => {
          this.logger.warn('ai.memory.subagent_extract_failed', {
            conversationId,
            runId: subRunId,
            reason: error instanceof Error ? error.message : String(error),
          })
        })
    }
    return outcome
  }

  /** 没跑起来（配额 / 深度）：记一条状态事件，把原因作为工具结论交回模型 */
  private async rejected(
    request: SubAgentRequest,
    startedAt: number,
    reason: string,
  ): Promise<SubAgentOutcome> {
    request.onSpawned?.(null, reason)
    this.logger.warn('ai.subagent.rejected', {
      parentRunId: request.envelope.parentRunId,
      name: request.name,
      reason,
    })
    /**
     * 父 run 已终态时**不再写时间线**：异步拒绝回调可能在父 run 收尾之后才到，
     * 写进去就是一条"已结束的 run 又冒出新事件"的孤儿（2026-11-15 实测：父 run 17:23:37 结束，
     * 17:23:50 还被写入一条 subagent_rejected）。拒绝结论本身仍通过返回值交给调用方。
     */
    const parentRun = await this.runs.findEntity(request.envelope.parentRunId)
    if (parentRun && ACTIVE_RUN_STATUSES.has(parentRun.status)) {
      await this.timelines.append({
        conversationId: request.envelope.conversationId,
        runId: request.envelope.parentRunId,
        role: TimelineRole.System,
        kind: TimelineKind.Status,
        payload: { status: 'subagent_rejected', name: request.name, reason },
        finishedAt: new Date(),
      })
    } else {
      this.logger.warn('ai.subagent.rejected_parent_closed', {
        parentRunId: request.envelope.parentRunId,
        name: request.name,
        reason,
      })
    }
    return {
      subRunId: null,
      conversationId: null,
      name: request.name,
      status: 'rejected',
      result: '',
      error: null,
      stepCount: 0,
      toolCallCount: 0,
      usage: null,
      durationMs: Date.now() - startedAt,
      reason,
    }
  }

  /** 片段 → 增量（文本 / 推理）；其余类型返回 null */
  private toDelta(chunk: ChunkLike): { kind: 'text' | 'reasoning'; text: string } | null {
    if (chunk.type === 'text-delta' && chunk.delta) return { kind: 'text', text: chunk.delta }
    if (chunk.type === 'reasoning-delta' && chunk.delta) {
      return { kind: 'reasoning', text: chunk.delta }
    }
    return null
  }

  /** 片段 → 结构化事件（工具调用与结果；这些是嵌套面板要展示的"细节"） */
  private toEvent(chunk: ChunkLike): Record<string, unknown> | null {
    const callId = chunk.toolCallId ?? null
    switch (chunk.type) {
      case 'tool-input-available': {
        if (callId && chunk.toolName) this.toolNames.set(callId, chunk.toolName)
        return {
          kind: 'tool-call',
          toolCallId: callId,
          toolKey: chunk.toolName ?? null,
          // 入参**完整**下发（与落库口径一致，不裁剪）
          input: chunk.input ?? null,
        }
      }
      case 'tool-output-available': {
        const toolKey = chunk.toolName ?? (callId ? this.toolNames.get(callId) : null) ?? null
        if (callId) this.toolNames.delete(callId)
        return {
          kind: 'tool-result',
          toolCallId: callId,
          toolKey,
          output: chunk.output ?? null,
          isError: false,
        }
      }
      case 'tool-output-error': {
        const toolKey = chunk.toolName ?? (callId ? this.toolNames.get(callId) : null) ?? null
        if (callId) this.toolNames.delete(callId)
        return {
          kind: 'tool-result',
          toolCallId: callId,
          toolKey,
          errorText: chunk.errorText ?? null,
          isError: true,
        }
      }
      default:
        return null
    }
  }

  /**
   * 写"增量"块：**不带 id**。
   *
   * AI SDK v6 的 data part 是**按 id 归并**的（同 id 后者覆盖前者），所以增量必须一块一个；
   * 状态类信息才用 id 归并成"当前快照"（见 {@link writeState}）。
   */
  private async writeDelta(
    request: SubAgentRequest,
    subRunId: string,
    kind: 'text' | 'reasoning',
    text: string,
  ): Promise<void> {
    if (!request.writer) return
    await request.writer.write({
      type: 'data-sub-agent-delta',
      data: { runId: subRunId, name: request.name, kind, text },
    })
  }

  /** 写"状态"块：带 `id = subRunId`，前端按 id 归并出这个子 agent 的当前快照 */
  private async writeState(
    request: SubAgentRequest,
    subRunId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (!request.writer) return
    await request.writer.write({
      type: 'data-sub-agent',
      id: subRunId,
      // `toolCallId` = 发起这次委派的 `run-sub-agent` 调用 id：前端据此把"原始工具卡"与
      // "子助手紧凑卡"去重（同一件事不画两张卡），以及把事件并进对应的卡
      data: { runId: subRunId, toolCallId: request.toolCallId, name: request.name, ...data },
    })
  }
}
