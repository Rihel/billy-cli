import { Inject, Injectable } from '@nestjs/common'
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { AppLogger } from '@repo/kits'
import { TOOL_KEYS } from '../tools/tool-keys.js'
import type { AgentTool, AgentToolInstance } from '../tools/tools.types.js'
import { AgentRunner, type SubAgentWriter } from '../runtime/agent-runner.js'
import { readAgentRuntime, type AgentCore } from './ai.core.types.js'

/**
 * 子 agent 工具的入参契约（**给模型看的契约**）。
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
      '**你亲自为它撰写的系统提示词**：它的身份、职责、可用工具的使用要求、交付物格式与边界。' +
        '注意它**看不到你与用户的对话**，所有必要背景都要写进去。',
    ),
  task: z
    .string()
    .min(1)
    .max(8000)
    .describe('交给它的具体任务（自包含：背景 + 要做的事 + 交付物与格式要求）'),
})

/**
 * **子 agent 能力**（core bean）：提供 `run-sub-agent` 工具 —— 主 agent 用它**在运行期创建**子 agent。
 *
 * 与旧设计的根本差别（`docs/design/ai-agent.md` §3.14）：子 agent **不是**装配期声明的固定角色，
 * 而是主 agent 为一个子任务现场造出来的临时助手：
 * - 提示词由主 agent 现写（本工具的 `system_prompt`）；
 * - 工具面 = **全部工具 − 委派类工具**（所以它不能再造子 agent，深度天然为 1）；
 * - 它的一切明细都入库（独立 run + 完整时间线）。
 *
 * 本 bean 刻意**不注入 `ToolBuilder`**：子 agent 的工具面由编排层算好、经 `requestContext` 传进来。
 * 否则 `ToolBuilder`（依赖 core bean）与本 bean（需要工具面）会互相依赖 —— 装配成环。
 */
@Injectable()
export class SubAgentCore implements AgentCore {
  /** core bean 的 key（诊断用） */
  readonly key = 'subagent'

  private readonly runSubAgent: AgentTool

  constructor(
    @Inject(AgentRunner) private readonly runner: AgentRunner,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    const key = TOOL_KEYS.runSubAgent
    const description =
      '创建一个**专职子助手**并让它完成一件明确的事，然后继续你自己的流程。' +
      '适用：可以独立完成、且独立完成后能一句话交代清楚结果的子任务（长文档撰写、批量核对、' +
      '独立分析、多方案并行的其中一路）。' +
      '不适用：一步就能答完的事、需要边做边和用户确认的事、以及"把整个任务原样丢出去"。' +
      '它**看不到你与用户的对话**，所以 `system_prompt` 与 `task` 必须自包含；' +
      '它有你的全部工具（除了不能再创建子助手），能查数据、执行操作。' +
      '它返回结论、步数、工具调用次数与消耗；**你要用自己的话把结论汇报给用户**，' +
      '不要把它的原始输出整段转贴。'
    this.runSubAgent = {
      key,
      title: '创建子助手',
      description,
      // 关键标记：子 agent 的工具面 = 全部 − 委派类（于是它拿不到本工具）
      delegation: true,
      tool: createTool({
        id: key,
        description,
        inputSchema: RunSubAgentInputSchema,
        execute: async (input, context) => {
          // 信封由编排层注入；缺失说明工具被装配到了我们没有运行时上下文的地方（配置错误）
          const envelope = readAgentRuntime(context?.requestContext)
          if (!envelope) {
            this.logger.error('ai.subagent.missing_runtime', { name: input.name })
            throw new Error(
              'run-sub-agent 缺少运行时上下文（编排层未注入 requestContext）—— 这是配置错误，请联系维护者',
            )
          }
          return this.runner.runSubAgent({
            name: input.name,
            systemPrompt: input.system_prompt,
            task: input.task,
            toolCallId: context?.agent?.toolCallId ?? null,
            envelope,
            // 非流式调用没有 writer：跳过实时出口，**只落库**（前端看历史，内容一样全）
            writer: context?.writer as unknown as SubAgentWriter | undefined,
          })
        },
      }) as AgentToolInstance,
    }
  }

  asTools(): readonly AgentTool[] {
    return [this.runSubAgent]
  }
}
