import { Inject, Injectable } from '@nestjs/common'
import dedent from 'dedent'
import { z } from 'zod'
import { AppLogger } from '@repo/kits'
import { ToolDecl, ToolGroup } from '../core/tools/tool.decorator.js'
import { TOOL_KEYS } from '../core/tools/tool-keys.js'
import { ToolDeniedError } from '../core/tools/tools.types.js'
import type { ToolCallContext } from '../core/tools/tools.types.js'
import { AgentRunner, type SubAgentOutcome } from '../runtime/agent-runner.js'
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

/**
 * **子 agent 工具**（`run-sub-agent`）：主 agent 用它**在运行期创建**子 agent。
 *
 * - 提示词由主 agent 现写（本工具的 `system_prompt`）；
 * - 工具面 = **全部工具 − 委派类 − `child: deny`**（所以它不能再造子 agent，深度天然为 1）；
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

      约束：\`system_prompt\` 与 \`task\` 必须**自包含**（它看不到你与用户的对话，
      背景、约束、交付物格式都要写进去）；它有你的全部工具（除再造子助手）；
      它返回结论与消耗，**你要用自己的话汇报**，不要整段转贴；你仍是这一轮的责任人。
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
    return this.runner.runSubAgent({
      name: input.name,
      systemPrompt: input.system_prompt,
      task: input.task,
      toolCallId: ctx.toolCallId,
      envelope,
      // 非流式调用没有 writer：跳过实时出口，**只落库**（前端看历史，内容一样全）
      ...(ctx.writer ? { writer: ctx.writer } : {}),
      // 四个旋钮从工具配置来（0 = 沿用部署默认，见 AgentRunner）
      quotas: ctx.settings.config,
    })
  }
}
