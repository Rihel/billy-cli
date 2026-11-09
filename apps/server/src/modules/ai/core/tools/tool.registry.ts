import { Inject, Injectable } from '@nestjs/common'
import { buildToolSpecs, type AgentToolGroup } from './tool.class.js'
import { ToolGateway } from './tool.gateway.js'
import { ToolConfigService } from './tool.config.service.js'
import { AGENT_TOOL_GROUPS, ALL_TOOLS } from './tools.types.js'
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

/** 一段工具来源：代码声明的（静态）或连接器产出的（动态） */
interface Entry {
  spec: ToolSpec
  tool: Tool
  /** 动态段才有：产出它的连接器 id */
  connectorId?: string
}

/**
 * **工具注册机**（设计 `docs/design/ai-agent-tool-engine.md` §5.3；连接器动态段见
 * `docs/design/ai-connector.md` §3.5）。
 *
 * 五件事：
 * 1. **注册与校验**：对 `AGENT_TOOL_GROUPS` 的每个工具组跑 `buildToolSpecs()`；
 *    key 重复、声明不全、`config.parse({})` 给不出默认值 —— 一律**启动即失败**；
 * 2. **动态段**：连接器同步时 `registerDynamic(connectorId, specs)`，停用 / 删除时
 *    `removeDynamic(connectorId)`；冲突只记日志 + 拒绝，不炸进程；
 * 3. **发工具**：`toolbox()` / `childToolbox()` 交给适配器，全部经网关包装；
 * 4. **读配置**：`settings(key)` 走 `ToolConfigService`（缓存 + 合并 + env 上限）；
 * 5. **元数据**：`describe()` 给提示词与后台列表用。
 *
 * 它**不**写库：代码工具的种子同步在 `ToolSeedService`（只喂 `staticSpecs()`），
 * 连接器工具由 `ConnectorSyncService` 写（只走 `registerDynamic`）。
 */
@Injectable()
export class ToolRegistry {
  private readonly staticTools = new Map<string, Entry>()
  private readonly dynamicTools = new Map<string, Entry>()
  /** 每次动态段变化 +1：适配器据此缓存"工具 → Mastra 工具"的转换结果 */
  private dynamicVersion = 0

  constructor(
    @Inject(AGENT_TOOL_GROUPS) groups: readonly AgentToolGroup[],
    @Inject(ToolGateway) private readonly gateway: ToolGateway,
    @Inject(ToolConfigService) private readonly config: ToolConfigService,
  ) {
    const register = (spec: ToolSpec, from: string): void => {
      if (!spec.key?.trim()) throw new Error(`${from} 提供的工具缺少 key`)
      if (this.staticTools.has(spec.key)) {
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
      this.staticTools.set(spec.key, { spec, tool: this.gateway.wrap(spec) })
    }

    for (const group of groups) {
      for (const spec of buildToolSpecs(group)) register(spec, group.constructor.name)
    }
    if (this.staticTools.size === 0) {
      throw new Error(
        '工具池不能为空：AGENT_TOOL_GROUPS 至少要登记一个工具组实例（否则 agent 连"能干什么"都没有）',
      )
    }
  }

  /** 动态段版本号（适配器缓存用） */
  get version(): number {
    return this.dynamicVersion
  }

  /**
   * 注册一批连接器工具。
   *
   * 冲突处理（刻意不抛到进程外）：key 已存在（静态或动态）就拒绝这一个，
   * 记日志后继续——一条连接器配错不该拖垮整个服务。返回值是实际注册成功的 key。
   */
  registerDynamic(
    connectorId: string,
    specs: readonly ToolSpec[],
    onConflict?: (message: string) => void,
  ): string[] {
    const registered: string[] = []
    for (const spec of specs) {
      const conflict = this.lookup(spec.key)
      if (conflict) {
        onConflict?.(`连接器 ${connectorId} 的工具 key 冲突：${spec.key}`)
        continue
      }
      const defaults = spec.config.safeParse({})
      if (!defaults.success) {
        onConflict?.(`连接器 ${connectorId} 的工具 ${spec.key} 默认值不全`)
        continue
      }
      // 静态段与动态段共用同一个网关包装：治理链路只有一条
      this.dynamicTools.set(spec.key, {
        spec,
        tool: this.gateway.wrap(spec),
        connectorId,
      })
      registered.push(spec.key)
    }
    if (registered.length > 0) this.dynamicVersion += 1
    return registered
  }

  /** 摘掉一条连接器产出的全部工具 */
  removeDynamic(connectorId: string): string[] {
    const removed: string[] = []
    for (const [key, entry] of this.dynamicTools) {
      if (entry.connectorId === connectorId) {
        this.dynamicTools.delete(key)
        removed.push(key)
      }
    }
    if (removed.length > 0) this.dynamicVersion += 1
    return removed
  }

  /** 展开 `ALL_TOOLS`（其余 key 原样返回） */
  expand(keys: readonly string[]): string[] {
    if (!keys.includes(ALL_TOOLS)) return [...keys]
    const explicit = keys.filter((key) => key !== ALL_TOOLS)
    return [...new Set([...explicit, ...this.keys()])]
  }

  /** 取工具（未知 key 返回 undefined） */
  get(key: string): Tool | undefined {
    return this.lookup(key)?.tool
  }

  /** 取声明（未知 key 抛错：调用方总是在处理已注册的 key） */
  spec(key: string): ToolSpec {
    const entry = this.lookup(key)
    if (!entry) throw new Error(`未知的工具 key: ${key}（已注册: ${this.keys().join(', ')}）`)
    return entry.spec
  }

  /** 全部 key（静态 + 动态；诊断 / 后台对账用） */
  keys(): string[] {
    return [...this.staticTools.keys(), ...this.dynamicTools.keys()]
  }

  /** 代码声明的 key（种子同步只认这一段） */
  staticKeys(): string[] {
    return [...this.staticTools.keys()]
  }

  /** 全部声明（后台快照用） */
  specs(): ToolSpec[] {
    return [...this.staticTools.values(), ...this.dynamicTools.values()].map((entry) => entry.spec)
  }

  /** 代码声明（种子同步专用：连接器工具不该被"代码声明"覆盖） */
  staticSpecs(): ToolSpec[] {
    return [...this.staticTools.values()].map((entry) => entry.spec)
  }

  /** 元数据（提示词渲染 + 后台列表） */
  describe(keys?: readonly string[]): ToolMeta[] {
    const target = keys ? this.expand(keys).map((key) => this.spec(key)) : this.specs()
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

  /** 按授权清单组装工具箱（主 agent 用；`ALL_TOOLS` 在调用前展开） */
  toolbox(keys: readonly string[]): Toolbox {
    const tools = new Map<string, Tool>()
    for (const key of this.expand(keys)) {
      const entry = this.lookup(key)
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
    for (const [key, entry] of [...this.staticTools, ...this.dynamicTools]) {
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

  private lookup(key: string): Entry | undefined {
    return this.staticTools.get(key) ?? this.dynamicTools.get(key)
  }
}
