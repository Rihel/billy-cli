import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { AppLogger } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolCallContext } from '../core/tools/tools.types.js'
import { AgentRunner, type SubAgentOutcome } from '../runtime/agent-runner.js'
import { RunRepository } from '../runtime/run.repository.js'
import { TimelineRepository } from '../runtime/timeline.repository.js'
import { ConversationRunQueue } from '../runtime/run-queue.service.js'
import { subAgentResultPath } from '../runtime/subagent-result.js'
import { RunStatus, TimelineKind, TimelineRole } from '@repo/shared'
import type { AgentRuntimeEnvelope } from '../core/envelope.js'

/**
 * 子 agent 工具的入参定义（**给模型看的数据结构**）。
 *
 * 三个字段都是必需的，其中 `system_prompt` 是本设计的关键：
 * 子 agent 的提示词**没有静态模板**，必须由主 agent 在调用时现写 ——
 * 于是"这个子助手是谁、要它交什么、边界在哪"由当下这件事决定，而不是由装配期决定的固定角色。
 */
const RunSubAgentInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(40)
    .describe('子助手的短标识（如「待办统计」「方案评审」），用于展示与归档'),
  system_prompt: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      `**你亲自为它撰写的系统提示词**：它的身份、职责、可用工具的使用要求、交付物格式与边界。注意它**看不到你与用户的对话**，所有必要背景都要写进去。`,
    ),
  task: z
    .string()
    .min(1)
    .max(8000)
    .describe('交给它的具体任务（自包含：背景 + 要做的事 + 交付物与格式要求）'),
})

/**
 * 子 agent 的配置（全部有默认值；0 = 沿用部署默认）。
 *
 * 这四个旋钮以前在 env 里（`AGENT_SUBAGENT_*`），现在入库、免重启；env 仍在装配层作为兜底默认。
 */
const SubAgentConfigSchema = z.object({
  /** 同一父 run 下允许创建的子 agent 个数上限（0 = 用部署默认） */
  maxPerRun: z.number().int().nonnegative().default(0),
  /** 子 agent 深度上限（0 = 用部署默认） */
  maxDepth: z.number().int().nonnegative().default(0),
  /** 单个子 agent 的步数上限（0 = 沿用 `AGENT_MAX_STEPS`） */
  maxSteps: z.number().int().nonnegative().default(0),
  /** 单个子 agent 的墙钟上限（ms；0 = 沿用单轮上限） */
  timeoutMs: z.number().int().nonnegative().default(0),
})

type SubAgentConfig = z.infer<typeof SubAgentConfigSchema>

const ListSubAgentsInputSchema = z.object({
  status: z.string().optional().describe('只看某个状态（可选）'),
})

const WaitSubAgentsInputSchema = z.object({
  sub_agent_ids: z
    .array(z.string())
    .optional()
    .describe('要等的子 agent（subAgentId）；省略 = 本会话所有未完成的子助手（跨轮可见）'),
  timeout_ms: z
    .number()
    .int()
    .min(0)
    .max(120_000)
    .default(30_000)
    .describe('最多等多久（毫秒）；到点返回 pending，不算失败'),
})

const CancelSubAgentInputSchema = z.object({
  sub_agent_id: z.string().min(1).describe('要取消的子 agent（subAgentId = 子会话 id）'),
})

const NoConfigSchema = z.object({})

/**
 * **子 agent 工具**（`run-sub-agent`）：主 agent 用它**在运行期创建**子 agent。
 *
 * - 提示词由主 agent 现写（本工具的 `system_prompt`）；
 * - 工具面 = **与主 agent 同一份 − 委派类 − `child: deny`**（所以它不能再造子 agent，深度天然为 1）；
 * - 它的一切明细都入库（独立 run + 完整时间线）；
 * - **信封会传下去**（`AgentRunner` 造临时 Agent 时注入 `requestContext`，`depth + 1`）——
 *   于是网关的身份 / 作用域 / 限流与审计字段在子 agent 那轮同样成立。
 *
 * 本工具刻意**不注入注册机**：子 agent 的工具面由编排层算好放进信封 ——
 * 否则注册机（依赖本工具）与本工具会互相依赖，装配成环。
 */
@Injectable()
@ToolGroup({ category: 'core', scope: 'all', child: 'deny' })
export class RunSubAgentTool {
  constructor(
    @Inject(AgentRunner) private readonly runner: AgentRunner,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(RunRepository) private readonly runs: RunRepository,
    @Inject(TimelineRepository) private readonly timelines: TimelineRepository,
    @Inject(ConversationRunQueue) private readonly runQueue: ConversationRunQueue,
  ) {}

  // 工具说明 = **这个工具的唯一一份说明**（系统提示词里的「工具」段直接渲染它）
  @ToolDecl({
    key: TOOL_KEYS.runSubAgent,
    title: '创建子助手',
    // 关键标记：子 agent 的工具面要把委派类排除（于是它拿不到本工具，深度天然封顶）
    delegation: true,
    params: RunSubAgentInputSchema,
    config: SubAgentConfigSchema,
    description: dedent`
      创建一个**专职子助手**完成一件明确的事，然后继续你自己的流程。

      什么时候用：能独立完成、且完成后能一句话交代清楚的子任务
      （长文档撰写、批量核对、独立分析、多方案并行的其中一路）。
      什么时候不用：一步能答完的、需要边做边和用户确认的、把整个任务原样丢出去。

      约束：它有你的全部工具（除再造子助手）；它返回结论与消耗，**你要用自己的话汇报**，
      不要整段转贴；你仍是这一轮的责任人。
    `,
  })
  async execute(
    input: z.infer<typeof RunSubAgentInputSchema>,
    ctx: ToolCallContext<SubAgentConfig>,
  ): Promise<SubAgentOutcome> {
    // 信封由编排层注入；缺失说明工具被装配到了我们没有运行时上下文的地方（配置错误）
    const envelope = (ctx.envelope as AgentRuntimeEnvelope | null) ?? null
    if (!envelope) {
      this.logger.error('ai.subagent.missing_runtime', { name: input.name })
      throw new ToolDeniedError(
        'precheck-failed',
        'run-sub-agent 缺少运行时上下文（编排层未注入信封）—— 这是配置错误，请把这条结论告诉用户',
      )
    }
    const spawned = await this.runner.spawnSubAgent({
      name: input.name,
      systemPrompt: input.system_prompt,
      task: input.task,
      toolCallId: ctx.toolCallId,
      envelope,
      quotas: ctx.settings.config,
      ...(ctx.writer ? { writer: ctx.writer } : {}),
    })
    this.logger.log('ai.subagent.spawned', {
      parentRunId: envelope.parentRunId,
      ...spawned,
    })
    return {
      ...spawned,
      conversationId: spawned.subAgentId,
      name: input.name,
      status: 'running',
      result: '',
      error: null,
      stepCount: 0,
      toolCallCount: 0,
      usage: null,
      durationMs: 0,
    } as unknown as SubAgentOutcome
  }
  /** 看当前父 run 下的子 agent 状态（非阻塞，不消费结果） */
  @ToolDecl({
    key: TOOL_KEYS.subAgentList,
    title: '查看子助手状态',
    params: ListSubAgentsInputSchema,
    config: NoConfigSchema,
    description: dedent`
      查看当前这一轮派出的子 agent 状态（运行中 / 成功 / 失败 / 取消）。
      非阻塞，不等待、不消费结果；要看完整结论用 wait-sub-agent（传 sub_agent_ids），要取消用 cancel-sub-agent。
      返回状态与运行元数据（步数 / 工具次数 / 耗时 / token / 起止时间）与 batchRunId（哪一轮派的），
      **不返回结论**；本会话跨轮可见（第二轮能看到第一轮派出的子助手）。
      什么时候用：想知道子助手跑到哪了、有没有失败；不要用它代替等待。
    `,
  })
  async list(
    input: z.infer<typeof ListSubAgentsInputSchema>,
    ctx: ToolCallContext,
  ): Promise<{ agents: Array<Record<string, unknown>> }> {
    const envelope = ctx.envelope as AgentRuntimeEnvelope
    const workspaceId = envelope.workspaceConversationId ?? envelope.conversationId
    /**
     * **会话级**：跨轮 / 跨批次都能看到，唤醒 run 里也有效。
     * 按 `parentRunId` 查会漏 —— 第二轮、唤醒 run 的 run id 与子的 `parent_run_id` 对不上。
     * `batchRunId` 标出是哪一轮派的，模型自己按批区分。
     */
    const children = await this.runs.listSessionChildren(workspaceId)
    const latest = new Map<string, (typeof children)[number]>()
    for (const child of children) latest.set(child.conversationId, child)
    const agents: Array<Record<string, unknown>> = []
    for (const child of latest.values()) {
      if (input.status && child.status !== input.status) continue
      const usage = child.usage as Record<string, unknown> | null
      agents.push({
        subAgentId: child.conversationId,
        currentRunId: child.id,
        batchRunId: child.parentRunId,
        name: child.agentKey.replace(/^sub:/, ''),
        status: child.status,
        // 只给运行状态与元数据：结论由 wait-sub-agent / 唤醒通知给 path
        stepCount: child.stepCount,
        toolCallCount: child.toolCallCount,
        durationMs: child.durationMs ?? 0,
        tokens: typeof usage?.totalTokens === 'number' ? usage.totalTokens : 0,
        startedAt: child.startedAt ?? null,
        finishedAt: child.finishedAt ?? null,
        error: child.errorMessage ?? null,
      })
    }
    return { agents }
  }

  /** 父还在跑时，主动等子 agent 结果（会消费唤醒队列项） */
  @ToolDecl({
    key: TOOL_KEYS.waitSubAgent,
    title: '等待子助手',
    params: WaitSubAgentsInputSchema,
    config: NoConfigSchema,
    description: dedent`
      等指定的子 agent（或当前父 run 下所有子助手）完成。
      不传 sub_agent_ids = 等本会话所有未完成的子助手，**外加已完成但通知还没被收口的子**（跨轮可见）；
      传了就等指定的（已完成的也返回）。
      返回每个子助手的 path + 行数 + 字节数（不返回摘要）；**正文用 read-file 读 path**（按行分页、可续读）。
      最多等 timeout_ms；到点返回 pending，子 agent 会继续跑，父可以继续做别的。
      拿到的结果会被消费掉（之后不会再为它唤醒你）；没有 pending 时不要反复空等。
    `,
  })
  async wait(
    input: z.infer<typeof WaitSubAgentsInputSchema>,
    ctx: ToolCallContext,
  ): Promise<{ agents: Array<Record<string, unknown>>; pending: string[]; timedOut: boolean }> {
    const envelope = ctx.envelope as AgentRuntimeEnvelope
    const workspaceId = envelope.workspaceConversationId ?? envelope.conversationId
    const deadline = Date.now() + input.timeout_ms
    const terminal = new Set([
      RunStatus.Succeeded,
      RunStatus.Failed,
      RunStatus.Canceled,
      RunStatus.Interrupted,
    ])
    /**
     * 首轮锁定要等的子助手集合：
     * - 传了 `sub_agent_ids` → 就等这些（已完成的也会返回结果引用）；
     * - 没传 → 等**本会话当前所有未完成**的子助手 + **已完成但唤醒还没被消费**的子助手
     *   （跨轮 / 跨批次；唤醒 run 里同样有效）。
     *
     * 必须锁定而不是每轮重算：不传 id 时「未完成集合」跑完就空了，重算会让 `done` 永远是空数组
     * （2026-11-15 实测：session t9ums0…，白等 88 秒后拿到 `{agents:[], pending:[]}`）。
     *
     * 为什么要把「已完成但还没被消费」的也收进来：它们早已跑完、只是父这一轮还在忙，
     * 完成通知还在队列里排着。父这次收口如果不接，父 run 结束后就会补一轮**延迟唤醒**
     * （2026-11-15 实测：父已经 `sub-agent-list` + `read-file` 读过那份结论，仍被唤醒、
     * 回了一句"这条通知是延迟到达的…"，多烧 9.2 万 token）。
     */
    let targetIds: string[] | null = null
    for (;;) {
      const children = await this.runs.listSessionChildren(workspaceId)
      const latest = new Map<string, (typeof children)[number]>()
      for (const child of children) latest.set(child.conversationId, child)
      if (targetIds === null) {
        const queuedKeys = new Set(await this.runQueue.listQueuedSubAgentKeys(workspaceId))
        targetIds = input.sub_agent_ids?.length
          ? [...input.sub_agent_ids]
          : [...latest.values()]
              .filter((child) => !terminal.has(child.status) || queuedKeys.has(child.id))
              .map((child) => child.conversationId)
      }
      const targets = targetIds
        .map((id) => latest.get(id))
        .filter((child): child is (typeof children)[number] => Boolean(child))
      const done = targets.filter((child) => terminal.has(child.status))
      const pending = targets.filter((child) => !terminal.has(child.status))
      if (pending.length === 0 || Date.now() >= deadline) {
        const agents: Array<Record<string, unknown>> = []
        for (const child of done) {
          const result =
            child.status === RunStatus.Succeeded
              ? ((await this.timelines.lastTextOfRun(child.id)) ?? '')
              : ''
          /**
           * 消费队列项 = 这一次不会再起唤醒 run。**卡由消费者写**：
           * - 不 wait 的正常路径由 dispatcher 消费并写卡（`wakeCard`）；
           * - wait 抢先消费时 dispatcher 拿不到这一项，卡就会永远缺失（实测：父会话里一张完成卡都没有）。
           * `consumeByDedupe` 只对 `queued` 生效且返回是否命中，所以两条路径天然不重复。
           *
           * 先打「已交付」标记再消费行：标记管的是**事实**（结果已在父手里），
           * 入队端与调度端都查它 —— 于是即使这一笔的队列行还没建出来（子 run 先翻终态、
           * 后入队），晚到的唤醒也会被挡住。
           */
          await this.runQueue.markConsumed(child.id)
          const consumed = await this.runQueue.consumeByDedupe(child.id)
          /**
           * **卡必须有人写**，否则时间线上就没有"子助手完成"这条证据（用户也看不到那张卡）。
           * 三种情形：
           * - `consumed` = true：我们抢到了队列行 → 由我们写（dispatcher 不会再有这一项）；
           * - 行还在（`dispatching/started/done…`）：已被 dispatcher 取走，它在起 run 时写卡 → 不重复写；
           * - **行根本不存在**：子 run 先翻终态、队列行还没建，而「已交付」标记会把晚到的入队挡掉
           *   → dispatcher 永远不会跑，没有第二个人会写 —— 只能由这里补。
           */
          const noQueueRow = !consumed && (await this.runQueue.findByDedupe(child.id)) === null
          if (consumed || noQueueRow) {
            await this.timelines.append({
              conversationId: envelope.conversationId,
              runId: envelope.parentRunId,
              role: TimelineRole.System,
              kind: TimelineKind.Status,
              payload: {
                status: 'subagent_completed',
                subAgentId: child.conversationId,
                subRunId: child.id,
                name: child.agentKey.replace(/^sub:/, ''),
                childStatus: child.status,
                summary: result ? result.slice(-500) : null,
                error: child.errorMessage ?? null,
                childConversationId: child.conversationId,
                path: subAgentResultPath(child.agentKey.replace(/^sub:/, ''), child.id),
              },
              finishedAt: new Date(),
            })
          }
          const name = child.agentKey.replace(/^sub:/, '')
          agents.push({
            subAgentId: child.conversationId,
            currentRunId: child.id,
            name,
            status: child.status,
            /**
             * 只给文件元信息（路径 / 行数 / 字节数）：正文让模型自己 `read-file` 读。
             *
             * 大小按子 run 的**最后正文**算，不再 `stat` 宿主本地文件 —— 结论由引擎写到
             * 工作区执行面（容器 / 远程），宿主本地那份根本不存在；
             * 旧实现用本地 stat 报出「有 3604 字节」，父 agent 按路径读却 404（2026-11-22 实测）。
             */
            ...(child.status === RunStatus.Succeeded && result
              ? {
                  path: subAgentResultPath(name, child.id),
                  bytes: Buffer.byteLength(result, 'utf8'),
                  lines: result.split('\n').length,
                }
              : {}),
          })
        }
        return {
          agents,
          pending: pending.map((child) => child.conversationId),
          timedOut: pending.length > 0,
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }

  /** 取消某个子 agent（子会话）当前正在跑的 run */
  @ToolDecl({
    key: TOOL_KEYS.cancelSubAgent,
    title: '取消子助手',
    params: CancelSubAgentInputSchema,
    config: NoConfigSchema,
    description: dedent`
      取消一个子 agent 正在跑的 run（不删除它的会话与历史）。
      已完成的子 agent 返回当前状态，不会报错；父被 stop / 删会话时也会级联取消。
    `,
  })
  async cancel(
    input: z.infer<typeof CancelSubAgentInputSchema>,
    ctx: ToolCallContext,
  ): Promise<{ canceled: boolean; status: string }> {
    const envelope = ctx.envelope as AgentRuntimeEnvelope
    const children = await this.runs.listChildren(envelope.parentRunId)
    const rows = children.filter((child) => child.conversationId === input.sub_agent_id)
    for (const child of rows) await this.runQueue.cancelByDedupe(child.id)
    const canceled = await this.runs.cancelActive(input.sub_agent_id)
    return { canceled: canceled > 0, status: canceled > 0 ? 'canceled' : 'unchanged' }
  }
}
