import { Inject, Injectable } from '@nestjs/common'
import type { ToolsInput } from '@mastra/core/agent'
import { AGENT_CORES, type AgentCore } from '../core/ai.core.types.js'
import { AGENT_TOOLS, type AgentTool } from './tools.types.js'
import type { ToolKey } from './tool-keys.js'

/** 工具的元数据（提示词渲染 + 诊断用） */
export interface AgentToolMeta {
  /** 工具 key（我们的对外标识；模型在提示词里看到的就是它） */
  key: string
  title: string
  description: string
}

/**
 * 工具构建器（bean）：**统一管理全部工具 bean** —— 汇总、校验、按 key 取用。
 *
 * 它承担三件事，每件都只做一次（其余地方只消费）：
 * 1. `describe(ids)`：给提示词引擎提供「这个 agent 能用哪些工具」的元数据，
 *    于是提示词里的工具清单永远等于实际挂上去的工具，不会漂移；
 * 2. `build(ids)`：把工具 bean 里的 Mastra 实例按 id 组装成 Agent 需要的 `ToolsInput`；
 * 3. **装配期校验**：agent 声明了不存在的工具 key 直接抛错（启动失败），
 *    而不是等用户提问时才发现某能力静默缺失。
 *
 * **两个来源**（见设计文档 §3.14.1）：
 * - `AGENT_TOOLS`：业务工具 bean（`ai/tools/*.tool.ts`，绑定单一业务模块）；
 * - `AGENT_CORES`：**core bean**（`ai/core/*.core.ts`），用 `asTools()` 交出跨业务的运行时能力
 *   （规划、子 agent 创建）。
 *
 * 两个来源在这里拍平成**同一张 key → 工具表**，于是重复 key 是启动期错误、
 * 提示词渲染与实际挂载的工具永远同源。
 */
@Injectable()
export class ToolBuilder {
  /** key → 工具（构造期建立，之后只读） */
  private readonly byKey: Map<string, AgentTool>

  constructor(
    @Inject(AGENT_TOOLS) tools: AgentTool[],
    @Inject(AGENT_CORES) cores: AgentCore[],
  ) {
    this.byKey = new Map()
    const register = (tool: AgentTool, from: string): void => {
      if (!tool.key) throw new Error(`${from} 提供的工具缺少 key`)
      if (this.byKey.has(tool.key)) {
        throw new Error(
          `工具 key 重复：${tool.key}（来源 ${from}；一个 key 只能有一个提供者）`,
        )
      }
      this.byKey.set(tool.key, tool)
    }
    for (const tool of tools) register(tool, 'AGENT_TOOLS')
    for (const core of cores) {
      for (const tool of core.asTools()) register(tool, `core:${core.key}`)
    }
    if (this.byKey.size === 0) {
      throw new Error('没有注册任何工具：AGENT_TOOLS 与 AGENT_CORES 汇总为空')
    }
  }

  /** 委派类工具的 key（创建 / 指挥子 agent 的工具）—— 子 agent 的工具面要把它们排除 */
  delegationKeys(): string[] {
    return [...this.byKey.values()]
      .filter((tool) => tool.delegation)
      .map((tool) => tool.key)
  }

  /**
   * 子 agent 的工具面 = **全部工具 − 委派类工具**（设计文档 §3.14.2）。
   *
   * 这样"子 agent 不能创建子 agent"是**能力上不可能**，而不是靠提示词请求它别这么做；
   * 深度也因此在结构上封顶。
   */
  buildDelegable(): ToolsInput {
    const excluded = new Set(this.delegationKeys())
    return this.build(this.keys().filter((key) => !excluded.has(key)))
  }

  /** 全部工具 key（诊断 / 测试用） */
  keys(): string[] {
    return [...this.byKey.keys()]
  }

  /** 取元数据（提示词渲染用）；未知 id 抛错（装配期问题，早失败） */
  describe(toolKeys: readonly string[]): AgentToolMeta[] {
    return toolKeys.map((toolKey) => {
      const meta = this.get(toolKey)
      return { key: meta.key, title: meta.title, description: meta.description }
    })
  }

  /** 按 id 组装 Mastra 工具集（装配 Agent 用）；未知 id 抛错 */
  build(toolKeys: readonly ToolKey[] | readonly string[]): ToolsInput {
    const tools: ToolsInput = {}
    for (const toolKey of toolKeys) {
      tools[toolKey] = this.get(toolKey).tool
    }
    return tools
  }

  private get(toolKey: string): AgentTool {
    const tool = this.byKey.get(toolKey)
    if (!tool) {
      throw new Error(
        `未知的工具 key: ${toolKey}（已注册: ${this.keys().join(', ')}）`,
      )
    }
    return tool
  }
}
