import { AgentRuntimeClient } from '@repo/internal-sdk'
import type {
  AgentConversationCancelResultModel,
  AgentInfoModel,
  AgentTimelineStatusResultModel,
  AgentInstructionsDto,
  AgentInstructionsModel,
  AgentListModel,
  AgentStatusModel,
} from '@repo/shared'
import { AgentNotFoundError } from '../modules/ai-admin/conversation/errors.js'

/** 构造入参：runtime 内部地址 + 服务间令牌（与 `/agent/*` 中转用的同一套 env） */
export interface AgentCatalogOptions {
  baseUrl: string
  token: string
  /** agent 清单缓存时长（静态声明只在发版时变；默认 30s） */
  cacheTtlMs?: number
}

const DEFAULT_CACHE_TTL_MS = 30_000

/**
 * main 侧的 agent 目录客户端（执行面 → 控制面的查询口）。
 *
 * **静态声明只在 agent-runtime 保留一份**：agent 规格、提示词模板、工具选择器、技能类型
 * 都在执行面装配；main 不再复制这些文件，否则「页面上看到的指令」与「模型真正收到的指令」
 * 会是两份、迟早漂移。这里只做两件事：转发查询 + 缓存清单（静态声明只在发版时变）。
 *
 * 边界：不做对话执行（chat / SSE 有自己的中转），也不写任何 agent 配置。
 */
export class AgentCatalogService {
  private readonly client: AgentRuntimeClient
  private readonly cacheTtlMs: number
  private cached: { at: number; value: AgentListModel } | null = null
  private pending: Promise<AgentListModel> | null = null

  constructor(options: AgentCatalogOptions) {
    this.client = new AgentRuntimeClient({
      baseUrl: options.baseUrl,
      token: options.token,
      // 目录查询要快：控制面页面等不起 30s 默认超时
      timeoutMs: 5_000,
    })
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
  }

  /** 能力状态（可用模型 + agent 数）：直接问执行面，不缓存（模型开关随时会改） */
  status(): Promise<AgentStatusModel> {
    return this.client.status()
  }

  /**
   * 取消会话内所有进行中的 run + 队列项。
   *
   * runs / timelines / conversation_run_queue 的写方是执行面；main 删会话前先调这里，
   * 再把会话行软删，避免控制面直接改运行状态。
   */
  cancelConversation(
    conversationId: string,
    operator: string,
  ): Promise<AgentConversationCancelResultModel> {
    // 删会话可能一次取消多轮 / 多个子 run，给比目录查询更宽的 30s
    return this.client.cancelConversation({ conversationId, operator }, { timeoutMs: 30_000 })
  }

  /** 追加控制面状态事件（改名 / 文件权限变更）；timeline 写方收口到 runtime */
  appendTimelineStatus(
    conversationId: string,
    payload: Record<string, unknown>,
  ): Promise<AgentTimelineStatusResultModel> {
    // 控制面审计事件不该拖慢页面主操作：给短超时，失败由调用方决定是否降级
    return this.client.appendTimelineStatus({ conversationId, payload }, { timeoutMs: 5_000 })
  }

  /** agent 清单（`skills: ['*']` 由执行面按当前技能库现算） */
  async list(): Promise<AgentListModel> {
    const fresh = this.cached && Date.now() - this.cached.at < this.cacheTtlMs
    if (fresh) return this.cached!.value
    // 并发请求只打一次 runtime（缓存过期瞬间的惊群）
    this.pending ??= this.client
      .list()
      .then((value) => {
        this.cached = { at: Date.now(), value }
        return value
      })
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  /**
   * 解析目标 agent key（省略取默认），不在清单里抛 3303。
   *
   * 在 main 侧先校验一次：runtime 的 4xx 在内部客户端里会变成传输错误，
   * 直接透出去会变成 500；这里用缓存清单还原成「agent 不存在」的业务语义。
   */
  async resolveAgentKey(agentKey?: string): Promise<string> {
    const catalog = await this.list()
    const key = agentKey ?? catalog.defaultAgentKey
    if (!catalog.agents.some((agent) => agent.key === key)) {
      throw new AgentNotFoundError(key)
    }
    return key
  }

  /** 按 key 找静态声明（快照里可能引用已下线的 agent，找不到返回 undefined） */
  async findAgent(agentKey: string | null | undefined): Promise<AgentInfoModel | undefined> {
    if (!agentKey) return undefined
    const catalog = await this.list()
    return catalog.agents.find((agent) => agent.key === agentKey)
  }

  /** 静态系统指令原文（渲染在 runtime，main 只转发） */
  instructions(input: AgentInstructionsDto): Promise<AgentInstructionsModel> {
    return this.client.instructions(input)
  }
}
