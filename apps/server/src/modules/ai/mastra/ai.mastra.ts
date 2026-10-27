import { Mastra } from '@mastra/core/mastra'
import type { ToolsInput } from '@mastra/core/agent'
import type { MastraCompositeStore } from '@mastra/core/storage'
import type { AgentModelId } from '../core/config.js'
import type { RuntimeModel } from '../core/envelope.js'
import { createMastraAgent, modelFromEnvelope } from './agent.adapter.js'
import { agentMemory } from './agent-memory.js'
import { askUserQuestionsTool } from './ask-user-questions.tool.js'
import type { AgentDefinition } from '../agents/types.js'

/**
 * Mastra 实例的注入 token（值为 `Mastra | null`：未配置模型时注入 null）。
 *
 * 用 token 而不是直接注入 `Mastra` 类：实例是工厂产物（`useFactory`），且允许为 null，
 * 消费方（`AgentService`）必须显式处理「未配置」这一分支。
 */
export const MASTRA = Symbol.for('MASTRA')

export interface CreateMastraOptions {
  /**
   * **按调用解析模型**（动态参数：构造期给函数，每次调用时用 requestContext 求值）。
   *
   * 为什么不是构造期定死一个模型：模型是**每个供应商配置里的一项**（`ai_models`），
   * 一轮对话可以用不同的模型（会话页能选），而且**只能用它**（§4.9）。
   */
  resolveModel: (
    definition: AgentDefinition,
    model: RuntimeModel,
  ) => { id: AgentModelId; url?: string; apiKey: string }
  /** 已渲染的 agent 定义（来自注册表） */
  definitions: readonly AgentDefinition[]
  /**
   * 按授权清单取工具（**已由适配器转成 Mastra 的 `ToolsInput`**）。
   *
   * 由装配层注入（注册机 `toolbox()` + `toMastraTools`）：core 因此不依赖任何具体工具，
   * 工具池（业务能力）与 Mastra 装配（机制）解耦，各自可单独替换 / 测试。
   */
  resolveTools: (toolIds: readonly string[]) => ToolsInput
  /**
   * 按授权清单取技能（**已转成 Mastra 的技能入参：技能目录路径**）。
   *
   * 路径而不是内联内容：Mastra 的 `LocalSkillSource` / `WorkspaceSkills` 会自己读盘，
   * 清单进提示词、正文与 `references/` 按需取（见 `SkillLoader` 与 `skill.adapter.ts`）。
   */
  resolveSkills: (skillNames: readonly string[]) => Promise<string[]>
  /** 存储适配层（我们写给 Mastra 的，只实现 workflows 域） */
  storage?: MastraCompositeStore
  /** 是否开启可恢复执行（durable）：开启后每步都落快照，崩溃后可从快照续跑（会重放 / 重跑，真花钱） */
  durableAgents?: boolean
  /** 对话记忆：durable resume 继续 agentic loop 需要（不传则 agent 无记忆） */
  memory?: import('@mastra/core/memory').MastraMemory
  /** 构造期取不到信封时警告一次（每个 agent 各求值一次，别刷屏） */
  onMissingEnvelope?: () => void
}

/**
 * 装配 Mastra 实例（唯一入口，**实例本身就是 agent 注册表**）。
 *
 * 它只做编排：`new Agent` / 模型描述 / 技能对象的 Mastra 词汇全在 `ai/mastra/**` 适配器里。
 *
 * 关于 `@mastra/nestjs` 适配器：它注册 catch-all 控制器（`@All('*')`）并在根路径抢注
 * `/health`、`/ready`、`/info`，会与本工程统一 POST 路由、响应信封拦截器、运维探针正面冲突，
 * 且其 peer 依赖尚不支持 NestJS 12 —— 故只用 `@mastra/core` 本体 + `@mastra/ai-sdk` 的流转换。
 */
export const createMastra = async ({
  resolveModel,
  definitions,
  resolveTools,
  resolveSkills,
  storage,
  durableAgents = false,
  memory,
  onMissingEnvelope,
}: CreateMastraOptions): Promise<Mastra> => {
  const built = new Map<string, ReturnType<typeof createMastraAgent>>()
  for (const definition of definitions) {
    const tools = resolveTools(definition.tools)
    // 问答（向用户提问并挂起）**只给主 agent**：子 agent 是临时执行体，没人能回答它。
    // 子 agent 的工具面来自注册机（`childToolbox()`），本来就拿不到这个原生工具；
    // 它缺信息时只能把问题交回主 agent（见 `agent-runner.ts` 的能力尾巴）。
    if (definition.key === 'assistant') tools['ask-user-questions'] = askUserQuestionsTool as never
    built.set(
      definition.key,
      createMastraAgent({
        // 我们的 agent key 映射到 Mastra 的 Agent.id（它的接口字段名叫 id，值是同一个字符串）
        id: definition.key,
        name: definition.name,
        /**
         * 系统指令：**编排层渲染好的那一份**（基础提示词 + 首轮运行环境）优先。
         *
         * 为什么用动态参数：`definition.instructions` 在装配期就定了，而「操作系统 + 当前时间」
         * 得在**会话开局那一刻**求值；编排层把全文放进运行时信封，同一份文本还会落库成快照。
         * 构造期可能不带 requestContext 求值一次 → 这里**不能抛错**，拿不到就用基础指令。
         */
        instructions: ({ requestContext }) => {
          const envelope = (
            requestContext as { getRaw?: (key: string) => unknown } | undefined
          )?.getRaw?.('billy.agentRuntime') as { systemPrompt?: string } | undefined
          return envelope?.systemPrompt ?? definition.instructions
        },
        // 模型每次调用按信封里的"这一轮用哪个模型"求值；构造期给占位模型（见适配器注释）
        model: modelFromEnvelope(
          (model) => resolveModel(definition, model),
          () => onMissingEnvelope?.(),
        ),
        tools,
        memory: memory ?? agentMemory,
        // 技能按角色授权，交**目录路径**给 Mastra：清单注入 + 正文/参考文件按需读都由它负责
        // （`skill` / `skill_search` / `skill_read` 工具；我们只管发现与校验，见 `SkillLoader`）
        skills: [...(await resolveSkills(definition.skills))],
        ...(durableAgents ? { durable: true } : {}),
        ...(memory ? { memory } : {}),
      }),
    )
  }

  // 顶层 agent 之间**没有**委派关系，故不需要拓扑排序（子 agent 不走注册表）。
  return new Mastra({
    agents: Object.fromEntries(built.entries()),
    ...(storage ? { storage } : {}),
  })
}
