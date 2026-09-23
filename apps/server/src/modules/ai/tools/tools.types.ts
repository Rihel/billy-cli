import type { ToolsInput } from '@mastra/core/agent'

/**
 * 工具 bean 的契约：**一个工具 = 一个 `@Injectable()` bean**。
 *
 * 为什么不做成「一个函数返回一堆工具」：
 * - 工具的执行依赖（`TodoService` 等）由 Nest 注入，天然拿到与业务接口同一条链路，
 *   不需要在装配处手工 `new`、也不需要把依赖层层透传；
 * - 一个工具一个文件，改了哪个工具 diff 一眼可见；工具级单测可以直接 `new` 出来测；
 * - `ToolBuilder` 负责汇总（见 `tool.builder.ts`），装配处只登记 provider，不做收集逻辑。
 */
export interface AgentTool {
  /** 工具 key（kebab-case，模型可见；从 `tool-keys.ts` 取，禁止裸字符串） */
  readonly key: string
  /** 中文短语标题（提示词里列举用） */
  readonly title: string
  /** 给模型看的说明（何时用 / 何时不用） */
  readonly description: string
  /** Mastra 工具实例（`createTool` 产物，execute 已绑定本 bean 注入的业务依赖） */
  readonly tool: AgentToolInstance
  /**
   * 是否属于**委派类工具**（创建 / 指挥子 agent 的工具）。
   *
   * 唯一用途：算「子 agent 能用什么工具」= 全部 − 委派类 —— 于是子 agent
   * **拿不到创建子 agent 的能力**，深度天然封顶，不必靠提示词约束（§3.14.2）。
   */
  readonly delegation?: boolean
}

/** Mastra 工具实例类型（从 ToolsInput 取元素，避免依赖具体泛型签名） */
export type AgentToolInstance = ToolsInput[string]

/**
 * 全部工具 bean 的注入 token（Nest 多 provider 惯用法）。
 *
 * 在 `ai.module.ts` 里用
 * `{ provide: AGENT_TOOLS, inject: [A, B, C], useFactory: (...tools) => tools }`
 * 汇总 —— 新增工具要在这里登记一行（显式的代价换来「谁在用、绑定顺序」一目了然）。
 */
export const AGENT_TOOLS = Symbol.for('AgentTools')
