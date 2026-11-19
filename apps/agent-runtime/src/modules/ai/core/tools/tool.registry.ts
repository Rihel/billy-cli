import { Inject, Injectable } from '@nestjs/common'
import { buildToolSpecs, type AgentToolGroup } from './tool.class.js'
import { ToolGateway } from './tool.gateway.js'
import { ToolConfigService } from './tool.config.service.js'
import { scopeAllows } from './tool.scope.js'
import { AGENT_TOOL_GROUPS, ALL_TOOLS } from './tools.types.js'
import type {
  Tool,
  ToolCallerIdentity,
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

/** 一条已注册的工具：声明 + 网关包装后的可调用体 */
interface Entry {
  spec: ToolSpec
  tool: Tool
}

/**
 * **工具注册机**（设计 `docs/design/ai-agent-tool-engine.md` §5.3）。
 *
 * 四件事：
 * 1. **注册与校验**：对 `AGENT_TOOL_GROUPS` 的每个工具组跑 `buildToolSpecs()`；
 *    key 重复、声明不全、`config.parse({})` 给不出默认值 —— 一律**启动即失败**；
 * 2. **发工具**：`toolbox()` / `childToolbox()` 交给适配器，全部经网关包装；
 * 3. **读配置**：`settings(key)` 走 `ToolConfigService`（缓存 + 合并 + env 上限）；
 * 4. **元数据**：`describe()` 给提示词与后台列表用。
 *
 * 它**不**写库：工具的种子同步在 `ToolSeedService`（只喂 `staticSpecs()`）。
 */
@Injectable()
export class ToolRegistry {
  private readonly staticTools = new Map<string, Entry>()

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

  /**
   * 展开授权清单：`'*'` = 本注册机里的全部工具；具体 key 只认已注册的。
   *
   * **未知 key 直接跳过**：能力目录里的工具（bash / web-* / file-* …）不在注册机，
   * 由装配层按目录解析；这里不能抛错，否则一个受限 agent 写了自己的能力 key 就连启动都过不去。
   */
  expand(selectors: readonly string[]): string[] {
    const keys: string[] = []
    const seen = new Set<string>()
    const push = (key: string): void => {
      if (seen.has(key)) return
      seen.add(key)
      keys.push(key)
    }
    for (const selector of selectors) {
      const key = selector.trim()
      if (!key) continue
      if (key === ALL_TOOLS) {
        for (const registered of this.staticTools.keys()) push(registered)
        continue
      }
      if (this.staticTools.has(key)) push(key)
    }
    return keys
  }

  /**
   * 按**这次的调用身份**过滤工具面（装配期，而不是等到调用被拒）。
   *
   * 只过滤 `scope`：`all` 放行；`admin` / `user` 看身份；`agent` 看 `allowedAgents`。
   * 开关（`enabled`）仍由 `EnabledPlugin` 在调用期判——它是"临时关掉"，不是"没有授权"。
   */
  async authorized(keys: readonly string[], caller: ToolCallerIdentity): Promise<string[]> {
    const allowed: string[] = []
    for (const key of keys) {
      const settings = await this.config.settings(this.spec(key))
      if (scopeAllows(settings.scope, settings.allowedAgents, caller)) allowed.push(key)
    }
    return allowed
  }

  /**
   * **没有运行时身份**（构造期 / 装配期，拿不到信封）时能放行的工具面：只有 `scope='all'`。
   *
   * 不能因为"没有 caller"就返回全部 —— 那会让 admin / agent 作用域的工具出现在
   * 匿名或错配的调用面上（2026-11-14 评审：P1-3）。
   */
  async publicKeys(keys: readonly string[]): Promise<string[]> {
    const allowed: string[] = []
    for (const key of keys) {
      const settings = await this.config.settings(this.spec(key))
      if (settings.scope === 'all') allowed.push(key)
    }
    return allowed
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

  /** 全部 key（诊断 / 后台对账用） */
  keys(): string[] {
    return [...this.staticTools.keys()]
  }

  /** 代码声明的 key（种子同步只认这一段） */
  staticKeys(): string[] {
    return [...this.staticTools.keys()]
  }

  /** 全部声明（后台快照用） */
  specs(): ToolSpec[] {
    return [...this.staticTools.values()].map((entry) => entry.spec)
  }

  /** 代码声明（种子同步专用） */
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

  /** 按授权清单组装工具箱（主 agent 用；选择器在这里展开） */
  toolbox(keys: readonly string[]): Toolbox {
    const tools = new Map<string, Tool>()
    for (const key of this.expand(keys)) {
      const entry = this.lookup(key)
      if (entry) tools.set(key, entry.tool)
    }
    return tools
  }

  /**
   * 子 agent 的工具面 = **父 agent 的授权面 ∩ 全部 − 委派类 − `child: deny`**
   * （设计 §5.10 的第 2 条修正）。
   *
   * 为什么用父授权当上限：`run-sub-agent` 的语义是"子助手有你的全部工具"，
   * 不是"子助手有注册机里的全部工具"。不给上限的话，一个只被授权了查库的 agent
   * 可以造个孩子去执行命令 —— 授权就形同虚设。
   *
   * 排除法（委派类 / `child: deny`）不变：新工具默认子 agent 也能用，
   * 要"只给主 agent"必须显式声明。
   */
  childToolbox(parentTools?: readonly string[]): Toolbox {
    const allowed = parentTools ? new Set(this.expand(parentTools)) : null
    const tools = new Map<string, Tool>()
    for (const [key, entry] of this.staticTools) {
      if (allowed && !allowed.has(key)) continue
      if (entry.spec.delegation === true) continue
      if (entry.spec.child === 'deny') continue
      tools.set(key, entry.tool)
    }
    return tools
  }

  /**
   * 子 agent 工具面（**运行时身份版**）：在 {@link childToolbox} 的"父授权 ∩ 排除法"之上，
   * 再按这次 caller 的作用域过滤一遍。
   *
   * 为什么需要：`childToolbox` 只按父 agent 的**声明**收口；若父 agent 的声明里含
   * `scope=admin` 的工具、而这次触发者不是管理员，子 agent 仍会"看见"这些工具描述
   * （执行期才会被 `ScopePlugin` 拒绝）—— 白白浪费上下文，也给了提示词层面的操作空间。
   * 运行期应让模型**根本看不到**不该用的工具（2026-11-14 评审：P1-4）。
   */
  async authorizedChildToolbox(
    parentTools: readonly string[] | undefined,
    caller: ToolCallerIdentity,
  ): Promise<Toolbox> {
    const child = this.childToolbox(parentTools)
    const allowed = new Set(await this.authorized([...child.keys()], caller))
    const tools = new Map<string, Tool>()
    for (const [key, tool] of child) {
      if (allowed.has(key)) tools.set(key, tool)
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
    return this.staticTools.get(key)
  }
}
