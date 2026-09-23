import { Inject, Injectable } from '@nestjs/common'
import type { AgentListModel, AgentStatusModel } from '@repo/shared'
import type { Mastra } from '@mastra/core/mastra'
import {
  AgentConfig,
  isAgentConfigured,
  type AgentConfig as AgentConfigValue,
} from './ai.config.js'
import { AGENT_REGISTRY } from './ai.registry.js'
import type { AgentRegistry } from './ai.types.js'
import { MASTRA } from './ai.mastra.js'

/**
 * Agent 装配查询服务：能力状态 + agent 清单 + 取用已装配的 Mastra 实例。
 *
 * **本文件刻意不含对话逻辑**：会话运行（落库的消息、记忆、运行状态机、可恢复的流式输出）
 * 是独立的一块，等运行时方案定稿后由专门的 session / run 服务承担，见
 * `docs/design/ai-agent.md`。现在这里只保留「装配结果可查、可被消费」的最小面，
 * 好处是启动一次就能验证整条装配链路（配置 → 工具 bean → 技能 → 提示词 → Mastra）。
 */
@Injectable()
export class AgentService {
  constructor(
    /** 未配置模型时为 null（模块工厂决定）：调用方据此走「未配置」分支，而不是 500 */
    @Inject(MASTRA) private readonly mastra: Mastra | null,
    @Inject(AGENT_REGISTRY) private readonly registry: AgentRegistry,
    @Inject(AgentConfig) private readonly config: AgentConfigValue,
  ) {}

  /** 能力状态：前端据此决定展示对话区还是「未配置」指引 */
  status(): AgentStatusModel {
    return {
      available: isAgentConfigured(this.config),
      model: this.config.model ?? null,
      agentCount: this.registry.all().length,
    }
  }

  /** agent 清单：前端选择器的数据源 */
  list(): AgentListModel {
    return this.registry.list()
  }

  /** 已装配的 Mastra 实例（会话运行时的入口；未配置模型时为 null） */
  getMastra(): Mastra | null {
    return this.mastra
  }
}
