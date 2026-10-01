import {
  readToolDecl,
  readToolMethod,
  TOOL_EXEC_KEY,
  TOOL_NORMALIZE_KEY,
  TOOL_PRECHECK_KEY,
} from './tool.decorator.js'
import type { ToolSpec } from './tools.types.js'

/**
 * **工具类 → 工具声明**（设计 §5.2）：注册机唯一的装配入口。
 *
 * 一个工具类 = `@Injectable()` 类 + 类上 `@ToolDecl` + 方法上 `@ToolExec`（可选 `@ToolPrecheck`
 * / `@ToolNormalize`）。本文件把它们读出来拼成注册机认识的 `ToolSpec`，
 * 于是"装饰器声明"与"网关 / 注册机 / 后台页"之间只有这一处映射。
 *
 * 校验都在**启动期**做（漏声明 / 漏执行体 / 元数据不成对一律抛错），
 * 宁可起不来，也不要带着一个"看起来在册、实际调不动"的工具跑。
 */

/** 工具类的形状：只要有 `@ToolDecl` + `@ToolExec` 就是（成员类型由各自实现守） */
export type AgentToolClass = object

/** 规范化为数组（调用方少写一层类型体操） */
export type ToolInstanceList = readonly AgentToolClass[]

/** 从实例上取方法（装饰器登记的是方法名；方法不存在说明类被改坏了） */
const bound = <T>(instance: AgentToolClass, key: string | symbol, label: string): T => {
  const fn = (instance as Record<string | symbol, unknown>)[key]
  if (typeof fn !== 'function') {
    throw new Error(
      `工具类 ${instance.constructor.name} 的 @${label} 指向 ${String(key)}，但它不是方法`,
    )
  }
  return (fn as (...args: unknown[]) => unknown).bind(instance) as T
}

/**
 * 把工具类实例拼成 `ToolSpec`。
 *
 * 未知 / 不成对的情况全部抛错并指明是哪个类、缺了什么：
 * - 没有 `@ToolDecl`；
 * - 没有 `@ToolExec`；
 * - `@ToolDecl` 里缺 `key` / `params` / `config`（配置契约与参数契约是硬要求）。
 */
export const buildToolSpec = (instance: AgentToolClass): ToolSpec => {
  const ctor = instance.constructor
  const meta = readToolDecl(ctor)
  if (!meta) {
    throw new Error(
      `工具类 ${ctor.name} 没有 @ToolDecl(...)：每个工具类都要用装饰器声明"是什么"`,
    )
  }
  if (!meta.key?.trim()) throw new Error(`工具类 ${ctor.name} 的 @ToolDecl 缺少 key`)
  if (!meta.params) throw new Error(`工具类 ${ctor.name} 的 @ToolDecl 缺少 params（参数契约）`)
  if (!meta.config) throw new Error(`工具类 ${ctor.name} 的 @ToolDecl 缺少 config（配置契约）`)

  const execKey = readToolMethod(ctor, TOOL_EXEC_KEY)
  if (!execKey) {
    throw new Error(
      `工具类 ${ctor.name} 没有 @ToolExec() 方法：声明了工具就要有执行体（只写业务动作）`,
    )
  }
  const precheckKey = readToolMethod(ctor, TOOL_PRECHECK_KEY)
  const normalizeKey = readToolMethod(ctor, TOOL_NORMALIZE_KEY)

  return {
    key: meta.key,
    title: meta.title,
    description: meta.description,
    category: meta.category,
    scope: meta.scope,
    ...(meta.delegation === true ? { delegation: true } : {}),
    ...(meta.child ? { child: meta.child } : {}),
    ...(meta.paginate ? { paginate: meta.paginate } : {}),
    params: meta.params,
    ...(meta.result ? { result: meta.result } : {}),
    config: meta.config,
    ...(meta.secrets ? { secrets: meta.secrets } : {}),
    ...(meta.secretFields ? { secretFields: meta.secretFields } : {}),
    exec: (input: unknown, ctx: never) =>
      bound<(input: unknown, ctx: never) => Promise<unknown>>(instance, execKey, 'ToolExec')(
        input,
        ctx,
      ),
    ...(precheckKey
      ? {
          precheck: (input: unknown, ctx: never) =>
            bound<(input: unknown, ctx: never) => Promise<string | null> | string | null>(
              instance,
              precheckKey,
              'ToolPrecheck',
            )(input, ctx),
        }
      : {}),
    ...(normalizeKey
      ? {
          normalize: (config: never, caps: never) =>
            bound<(config: never, caps: never) => never>(instance, normalizeKey, 'ToolNormalize')(
              config,
              caps,
            ),
        }
      : {}),
  } as ToolSpec
}
