import type { CapabilityDefinition } from './define.js'

/**
 * **能力定义装饰器**：一个执行器类 = 一个能力组，**类内一个方法一个能力**。
 *
 * 形状与 runtime 的工具组 DSL 一致（`@ToolGroup` / `@ToolDecl`），读代码只有一套心智模型：
 *
 * ```
 * @Injectable()
 * @CapabilityGroup({ risk: 'write' })          // 组级：同类能力的共同默认值（可选）
 * export class BashExecutor {
 *   @CapabilityDecl({ tool: 'bash', title, description, input: z.object({ … }) })
 *   async bash(request: ToolInvokeRequest): Promise<ToolOutcome> { … }
 * }
 * ```
 *
 * 三条口径：
 * - **入参 zod 内联在声明里**（`@CapabilityDecl.input`），执行体经 `findCapabilityDecl` 取同一份
 *   来校准入参 —— 登记与执行不会各写一份而漂移；
 * - **声明与执行体同一处**：加一个能力 = 加一个方法，不新增 schemas 文件、不改汇总清单；
 * - 声明缺执行体 / 工具名重复在**启动期**就抛（`scanCapabilities`），而不是运行时静默失效。
 *
 * 元数据挂在**构造函数**上（`WeakMap`，不依赖 reflect-metadata）：`@CapabilityDecl` 收到的
 * `target` 是原型，取它的 `constructor` 就是类本身。
 */

/** 组级默认值：只放同类能力都一样的那几项，其余每能力各写各的 */
export interface CapabilityGroupMeta {
  risk?: CapabilityDefinition['risk']
  scope?: CapabilityDefinition['scope']
  idempotent?: CapabilityDefinition['idempotent']
  timeoutMs?: CapabilityDefinition['timeoutMs']
  pagination?: CapabilityDefinition['pagination']
  tags?: CapabilityDefinition['tags']
}

const GROUPS = new WeakMap<object, CapabilityGroupMeta>()
const DECLS = new WeakMap<object, Map<string, CapabilityDefinition>>()

/** 类级装饰器：给组内能力共同默认值（可省略；省了就在每个 `@CapabilityDecl` 里写） */
export const CapabilityGroup =
  (meta: CapabilityGroupMeta = {}) =>
  (target: object): void => {
    GROUPS.set(target, meta)
  }

/** 方法级装饰器：**这个方法是一个能力**（声明 + 执行体同一处） */
export const CapabilityDecl =
  (meta: CapabilityDefinition) =>
  (target: object, propertyKey: string | symbol): void => {
    const ctor = (target as { constructor: object }).constructor
    const method = String(propertyKey)
    const existing = DECLS.get(ctor) ?? new Map<string, CapabilityDefinition>()
    existing.set(method, meta)
    DECLS.set(ctor, existing)
  }

export interface ScannedCapability {
  /** 方法名（注册机用它绑执行体） */
  method: string
  /** 合并组级默认值之后的声明 */
  decl: CapabilityDefinition
}

const mergeGroup = (
  group: CapabilityGroupMeta,
  decl: CapabilityDefinition,
): CapabilityDefinition => ({
  ...decl,
  risk: decl.risk ?? group.risk ?? 'read',
  scope: decl.scope ?? group.scope ?? 'all',
  idempotent: decl.idempotent ?? group.idempotent ?? false,
  timeoutMs: decl.timeoutMs ?? group.timeoutMs ?? 30_000,
  pagination: decl.pagination ?? group.pagination ?? 'none',
  tags: decl.tags ?? group.tags ?? [],
})

const declsOf = (target: object): Map<string, CapabilityDefinition> =>
  DECLS.get(target.constructor) ?? new Map<string, CapabilityDefinition>()

/**
 * 扫描一个执行器实例的全部能力声明（按方法声明顺序），合并组级默认值。
 *
 * 启动期校验：声明的方法必须真的存在、工具名在组内唯一。
 */
export const scanCapabilities = (instance: object): ScannedCapability[] => {
  const group = GROUPS.get(instance.constructor) ?? {}
  const tools = new Set<string>()
  const scanned: ScannedCapability[] = []
  for (const [method, decl] of declsOf(instance)) {
    const handler = (instance as Record<string, unknown>)[method]
    if (typeof handler !== 'function') {
      throw new Error(`能力 ${decl.tool} 声明的执行体 ${method} 不存在`)
    }
    if (tools.has(decl.tool)) {
      throw new Error(`能力组里工具名重复：${decl.tool}`)
    }
    tools.add(decl.tool)
    scanned.push({ method, decl: mergeGroup(group, decl) })
  }
  return scanned
}

/** 按方法名读一条声明（执行体校准入参用；读不到就抛，别让漂移静默） */
export const readCapabilityDecl = (target: object, method: string): CapabilityDefinition => {
  const decl = declsOf(target).get(method)
  if (!decl) throw new Error(`没有能力声明：${method}`)
  return mergeGroup(GROUPS.get(target.constructor) ?? {}, decl)
}

/**
 * 按工具名读一条声明。
 *
 * 给「一个执行体服务多个工具」的组用（file / memory）：公共执行体只需要知道当前工具名。
 */
export const findCapabilityDecl = (target: object, tool: string): CapabilityDefinition => {
  for (const decl of declsOf(target).values()) {
    if (decl.tool === tool) {
      return mergeGroup(GROUPS.get(target.constructor) ?? {}, decl)
    }
  }
  throw new Error(`没有能力声明：${tool}`)
}

/** 读组级默认值（没写 `@CapabilityGroup` 就是空对象） */
export const readCapabilityGroup = (target: object): CapabilityGroupMeta =>
  GROUPS.get(target.constructor) ?? {}
