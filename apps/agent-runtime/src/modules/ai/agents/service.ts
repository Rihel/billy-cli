import { Inject, Injectable, Optional } from '@nestjs/common'
import type {
  AgentInstructionsDto,
  AgentInstructionsModel,
  AgentListModel,
  AgentStatusModel,
  AgentToolListModel,
} from '@repo/shared'
import type { Mastra } from '@mastra/core/mastra'
import { RUNTIME_MODEL_RESOLVER, type RuntimeModelResolver } from '../runtime/model-resolver.js'
import { AGENT_REGISTRY } from './registry.js'
import type { AgentRegistry } from './types.js'
import { MASTRA } from '../mastra/ai.mastra.js'
import { ALL_SKILLS } from '../core/skills/skills.types.js'
import { SkillLoader } from '../core/skills/skill.loader.js'
import { ToolRegistry } from '../core/tools/tool.registry.js'
import { GatewayToolCatalog } from '../runtime/gateway-capability-catalog.js'
import { renderAgentInstructions } from './instructions.js'
import { toJsonSchema } from '../core/tools/tool.schema.js'

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
    @Inject(RUNTIME_MODEL_RESOLVER) private readonly models: RuntimeModelResolver,
    @Inject(SkillLoader) private readonly skills: SkillLoader,
    @Inject(ToolRegistry) private readonly toolRegistry: ToolRegistry,
    // 目录不可用（未配网关 / 抖动）时退回装配期版本；单测可不传
    @Optional() @Inject(GatewayToolCatalog) private readonly catalog?: GatewayToolCatalog,
  ) {}

  /**
   * 能力状态：前端据此决定展示对话区还是「先去后台配模型」指引。
   *
   * **可用性只看库里有没有"供应商启用 + 模型启用"的模型**（§4.9）——
   * 环境变量不再决定 AI 能不能用（种子只在 main 的 `AiModelSeedService`，runtime 只读网关目录）。
   */
  async status(): Promise<AgentStatusModel> {
    const available = await this.models.listAvailable()
    return {
      available: available.models.length > 0,
      model:
        available.models.find((item) => item.id === available.defaultModelId)?.modelRef ?? null,
      modelCount: available.models.length,
      agentCount: this.registry.all().length,
    }
  }

  /**
   * agent 清单：前端选择器的数据源。
   *
   * `skills: ['*']` 在这里**现算**成当时的技能名：在线新建 / 停用的技能不需要重启就能在
   * 「这个 agent 能用哪些技能」里看到正确结果（每次请求多一次内存清单遍历，可忽略）。
   */
  async list(): Promise<AgentListModel> {
    const listed = this.registry.list()
    const names = await this.skills.names()
    return {
      ...listed,
      agents: listed.agents.map((agent) => ({
        ...agent,
        skills: agent.skills.includes(ALL_SKILLS) ? names : agent.skills,
      })),
    }
  }

  /**
   * **运行时内建工具清单**（控制面「工具配置」页的数据源）。
   *
   * 静态声明只在 runtime 一份：main 不再存 manifest 快照，要用就问这里。
   * 只列本进程注册机里的工具；能力目录里的能力由 main 直接问网关。
   */
  tools(): AgentToolListModel {
    return {
      tools: this.toolRegistry.specs().map((spec) => ({
        key: spec.key,
        title: spec.title,
        description: spec.description,
        category: spec.category,
        scope: spec.scope,
        paramSchema: toJsonSchema(spec),
      })),
    }
  }

  /**
   * 某个 agent 的**系统指令原文**（前端「查看系统指令」用它）。
   *
   * 直接回装配期渲染好的 `instructions`：**没有第二份副本** ——
   * 前端看到的与真正挂到这个 agent 上的提示词是同一个字符串
   * （要改就在模板里改，不可能出现"页面上是一套、跑起来是另一套"）。
   *
   * 未注册的 agentKey 由注册表抛 3303，**不静默回落成默认 agent**：
   * 回落会让人以为"我看的是这个 agent 的指令"，其实不是。
   */
  async instructions(input: AgentInstructionsDto): Promise<AgentInstructionsModel> {
    const definition = this.registry.resolve(input.agentKey)
    const instructions = await renderAgentInstructions(
      definition,
      this.toolRegistry,
      this.catalog,
      {
        isAdmin: false,
        userId: null,
        conversationId: 'agent-instructions',
      },
    )
    return {
      agentKey: definition.key,
      name: definition.name,
      description: definition.description,
      instructions,
      // 静态定义：没有会话、也没有快照时间
      source: 'definition',
      recordedAt: null,
    }
  }

  /** 已装配的 Mastra 实例（会话运行时的入口；未配置模型时为 null） */
  getMastra(): Mastra | null {
    return this.mastra
  }
}
