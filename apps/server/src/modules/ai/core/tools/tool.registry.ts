import { Inject, Injectable } from '@nestjs/common'
import { buildToolSpecs, type AgentToolGroup } from './tool.class.js'
import { ToolGateway } from './tool.gateway.js'
import { ToolConfigService } from './tool.config.service.js'
import { AGENT_TOOL_GROUPS } from './tools.types.js'
import type {
  Tool,
  ToolCategoryValue,
  ToolSettings,
  ToolSpec,
  Toolbox,
} from './tools.types.js'

/** 提示词与后台列表要的元数据（来自**代码声明**：装配期确定性，不受库里文案覆盖影响） */
export interface ToolMeta {
  key: string
  title: string
  description: string
  category: ToolCategoryValue
}

/**
 * **工具注册机**（设计 §5.3）：工具的唯一来源。
 *
 * 四件事：
 * 1. **注册与校验**：对 `AGENT_TOOL_GROUPS` 里的每个**工具组实例**跑 `buildToolSpecs()` 拿声明数组
 *    （一个组 1..n 个工具），key 重复、声明不全、`config.parse({})` 给不出默认值 —— 一律**启动即失败**；
 * 2. **发工具**：`toolbox()` / `childToolbox()` 交给适配器装配 Agent 的，都是网关包装过的工具。
 *    主 agent（`mastra/ai.mastra`）与子 agent（`agent-runner`）都从这里取，**没有旁路**；
 * 3. **读配置**：`settings(key)` 走 `ToolConfigService`（缓存 + 合并 + env 上限）；
 * 4. **元数据**：`describe()` 给提示词的《工具》段（与实际挂载的工具同源，不会漂移）。
 *
 * 它**不**写库：种子同步在 `ToolSeedService`（启动期跑一次），职责分开好测。
 */
@Injectable()
export class ToolRegistry {
  private readonly byKey = new Map<string, { spec: ToolSpec; tool: Tool }>()

  constructor(
    @Inject(AGENT_TOOL_GROUPS) groups: readonly AgentToolGroup[],
    @Inject(ToolGateway) gateway: ToolGateway,
    @Inject(ToolConfigService) private readonly config: ToolConfigService,
  ) {
    const register = (spec: ToolSpec, from: string): void => {
      if (!spec.key?.trim()) throw new Error(`${from} 提供的工具缺少 key`)
      if (this.byKey.has(spec.key)) {
        throw new Error(`工具 key 重复：${spec.key}（来源 ${from}；一个 key 只能有一个提供者）`)
      }
      // 默认值必须给全：`config.parse({})` 失败说明作者漏了 `.default()`
      const defaults = spec.config.safeParse({})
      if (!defaults.success) {
        throw new Error(
          `工具 ${spec.key} 的配置没有给全默认值（${from}）：${defaults.error.issues
            .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
            .join('; ')}`,
        )
      }
      this.byKey.set(spec.key, { spec, tool: gateway.wrap(spec) })
    }

    // 声明从工具组类上的装饰器元数据里读（组内没有 `@ToolDecl` 方法会在 builder 里抛错）
    for (const group of groups) {
      for (const spec of buildToolSpecs(group)) register(spec, group.constructor.name)
    }
    // 工具池不能为空 —— 否则 agent 连"能干什么"都没有
    if (this.byKey.size === 0) {
      throw new Error(
        '工具池不能为空：AGENT_TOOL_GROUPS 至少要登记一个工具组实例（否则 agent 连"能干什么"都没有）',
      )
    }
  }

  /** 取工具（未知 key 返回 undefined） */
  get(key: string): Tool | undefined {
    return this.byKey.get(key)?.tool
  }

  /** 取声明（未知 key 抛错：调用方总是在处理已注册的 key） */
  spec(key: string): ToolSpec {
    const entry = this.byKey.get(key)
    if (!entry) throw new Error(`未知的工具 key: ${key}（已注册: ${this.keys().join(', ')}）`)
    return entry.spec
  }

  /** 全部 key（诊断 / 后台对账用） */
  keys(): string[] {
    return [...this.byKey.keys()]
  }

  /** 全部声明（种子同步、后台快照用） */
  specs(): ToolSpec[] {
    return [...this.byKey.values()].map((entry) => entry.spec)
  }

  /** 元数据（提示词渲染 + 后台列表） */
  describe(keys?: readonly string[]): ToolMeta[] {
    const target = keys ? keys.map((key) => this.spec(key)) : this.specs()
    return target.map((spec) => ({
      key: spec.key,
      title: spec.title,
      description: spec.description,
      category: spec.category,
    }))
  }

  /** 生效配置（缓存 + 三级合并） */
  async settings(key: string): Promise<ToolSettings> {
    return this.config.settings(this.spec(key))
  }

  /** 按授权清单组装工具箱（主 agent 用） */
  toolbox(keys: readonly string[]): Toolbox {
    const tools = new Map<string, Tool>()
    for (const key of keys) {
      const entry = this.byKey.get(key)
      if (!entry) throw new Error(`未知的工具 key: ${key}（已注册: ${this.keys().join(', ')}）`)
      tools.set(key, entry.tool)
    }
    return tools
  }

  /**
   * 子 agent 的工具面 = **全部 − 委派类 − `child: deny`**（设计 §5.10 的第 2 条修正）。
   *
   * 排除法而不是白名单：新工具默认子 agent 也能用，要"只给主 agent"必须显式声明 `child: 'deny'`。
   */
  childToolbox(): Toolbox {
    const tools = new Map<string, Tool>()
    for (const [key, entry] of this.byKey) {
      if (entry.spec.delegation === true) continue
      if (entry.spec.child === 'deny') continue
      tools.set(key, entry.tool)
    }
    return tools
  }

  /** 委派类工具的 key（诊断用） */
  delegationKeys(): string[] {
    return this.specs()
      .filter((spec) => spec.delegation === true)
      .map((spec) => spec.key)
  }
}
