import { Agent, type ToolsInput } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import type { RequestContext } from '@mastra/core/request-context'
import type { MastraCompositeStore } from '@mastra/core/storage'
import type { InlineSkill } from '@mastra/core/skills'
import type { AgentModelId } from './ai.config.js'
import { toAgentModelId } from './ai.config.js'
import { readAgentRuntime } from './ai.core.types.js'
import type { AgentDefinition } from './ai.types.js'

/**
 * Mastra 实例的注入 token（值为 `Mastra | null`：未配置模型时注入 null）。
 *
 * 用 token 而不是直接注入 `Mastra` 类：实例是工厂产物（`useFactory`），且允许为 null，
 * 消费方（`AgentService`）必须显式处理「未配置」这一分支。
 */
export const MASTRA = Symbol.for('MASTRA')

export interface CreateMastraOptions {
  /**
   * **按调用解析模型**（Mastra 的 `DynamicArgument`：构造期给函数，每次调用时用 requestContext 求值）。
   *
   * 为什么不是构造期定死一个模型：模型是**每个供应商配置里的一项**（`ai_models`），
   * 一轮对话可以用不同的模型（会话页能选），而且**只能用它**（§4.9）。
   * 构造期定死就意味着"选模型"要重建 agent，或者退回环境变量 —— 两条都不要。
   */
  resolveModel: (
    definition: AgentDefinition,
    requestContext: RequestContext | undefined,
  ) => { id: AgentModelId; url?: string; apiKey: string }
  /** 已渲染的 agent 定义（来自注册表） */
  definitions: readonly AgentDefinition[]
  /**
   * 按授权清单取工具。
   *
   * 由装配层注入（`ToolBuilder.build`）：core 因此**不依赖任何具体工具**，
   * 工具池（业务能力）与 Mastra 装配（机制）解耦，各自可单独替换 / 测试。
   */
  resolveTools: (toolIds: readonly string[]) => ToolsInput
  /**
   * 按授权清单取技能（`skills/catalog/<name>/SKILL.md` 的加载结果）。
   *
   * 同样是注入而非直接依赖：core 不知道技能存在哪、怎么加载，只把它们挂到 Agent 上
   * （Mastra 会为配置了 skills 的 Agent 自动加激活工具与注入逻辑）。
   */
  resolveSkills: (skillNames: readonly string[]) => Promise<InlineSkill[]>
  /**
   * 存储适配层（我们写给 Mastra 的，只实现 workflows 域）。
   *
   * 传了它，Mastra 才有地方落"运行快照"，`recoverAllDurableAgents()` 才能工作；
   * 不传则退化为进程内（重启后无法恢复在跑的会话）。
   */
  storage?: MastraCompositeStore
  /** 是否开启可恢复执行（durable）：开启后每步都落快照，崩溃后可从快照续跑（会重放/重跑，真花钱） */
  durableAgents?: boolean
}

/**
 * 装配 Mastra 实例（唯一入口，**实例本身就是 agent 注册表**）。
 *
 * 为什么是「OpenAI 兼容对象式」而不是 `provider/model` 字符串：
 * 字符串形式只能连各家官方端点（靠 provider 自己的环境变量取密钥），而模板需要
 * 「一个 baseURL 通吃」—— DeepSeek / 通义 / 自建网关（vLLM、One-API 等）都是
 * OpenAI 兼容协议。对象式 `{ id, url, apiKey }` 同时覆盖两者：`url` 留空即走官方端点。
 *
 * 关于 `@mastra/nestjs` 适配器：它注册 catch-all 控制器（`@All('*')`）并在根路径抢注
 * `/health`、`/ready`、`/info`，会与本工程的统一 POST 路由、响应信封拦截器、运维探针
 * 正面冲突，且其 peer 依赖尚不支持 NestJS 12 —— 故只用 `@mastra/core` 本体 +
 * `@mastra/ai-sdk` 的流转换，HTTP 边界由本模块自己的控制器承担。
 */
export const createMastra = async ({
  resolveModel,
  definitions,
  resolveTools,
  resolveSkills,
  storage,
  durableAgents = false,
}: CreateMastraOptions): Promise<Mastra> => {
  const built = new Map<string, Agent>()
  for (const definition of definitions) {
    built.set(
      definition.key,
      new Agent({
        // 我们的 agent key 映射到 Mastra 的 Agent.id（它的接口字段名叫 id，值是同一个字符串）
        id: definition.key,
        name: definition.name,
        /**
         * 系统提示词：**编排层渲染好的那一份**（基础提示词 + 首轮运行环境）优先。
         *
         * 为什么用动态参数而不是拼成一个固定字符串：`definition.instructions` 在装配期就定了，
         * 而「操作系统 + 当前时间」得在**会话开局那一刻**求值（§3.15）。编排层把全文放进运行时信封
         * （提示词文本只走模板引擎，core 因此不依赖提示词引擎），并且**同一份文本会落库成快照**。
         *
         * ⚠️ 与下面的模型一样，Mastra 构造 durable agent 时可能**不带 requestContext** 求值一次
         * → 这里不能抛错：拿不到信封就用基础提示词。
         */
        instructions: ({ requestContext }: { requestContext: RequestContext }) =>
          readAgentRuntime(requestContext)?.systemPrompt ?? definition.instructions,
        // 模型是**每次调用**按 requestContext 里的"这一轮用哪个模型"求值的：
        // 供应商地址与密钥都来自后台配置（`ai_models` / `ai_providers`），没有环境变量兜底路径
        model: ({ requestContext }: { requestContext: RequestContext }) =>
          resolveModel(definition, requestContext),
        tools: resolveTools(definition.tools),
        // 技能按角色授权；Mastra 会为配置了 skills 的 Agent 自动加上技能激活与注入
        skills: await resolveSkills(definition.skills),
        // 注意：这里**没有** `agents: {}` —— 本工程不用 Mastra 的静态子 agent 编译（`agent-<key>` 工具）。
        // 子 agent 由 `run-sub-agent` 工具在运行期动态创建，见 docs/design/ai-agent.md §3.14。
        // 可恢复执行：每步落快照；崩溃后 `recoverAllDurableAgents()` 从快照续跑
        ...(durableAgents ? { durable: true } : {}),
      }),
    )
  }

  // 后续新增 workflow 也注册到这里（agents 与 workflows 是并列的注册表）。
  // 顶层 agent 之间**没有**委派关系，故不需要拓扑排序（子 agent 不走注册表）。
  return new Mastra({
    agents: Object.fromEntries(built.entries()),
    ...(storage ? { storage } : {}),
    // 恢复交给我们在 boot hook 里显式调用（`recovery.durableAgents: 'auto'` 依赖它的 deployer）
  })
}
