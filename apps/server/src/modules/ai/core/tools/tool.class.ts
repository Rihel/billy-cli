import { readToolDecls, readToolGroup } from './tool.decorator.js'
import type { ToolDeclMeta, ToolGroupMeta } from './tool.decorator.js'
import { withCallReason } from './call-reason.js'
import { normalizeToolEventDecls } from './tool-event.js'
import type { ToolSpec } from './tools.types.js'

/**
 * **工具组类 → 工具声明数组**（设计 §5.2）：注册机唯一的装配入口。
 *
 * 一个工具组类 = `@Injectable()` 类 + 若干带 `@ToolDecl` 的方法。本文件把组级默认值与每个方法的
 * 声明合并成 `ToolSpec`，于是"装饰器声明"与"网关 / 注册机 / 后台页"之间只有这一处映射。
 *
 * 校验全部在**启动期**做（宁可起不来，也不要带着一个"看起来在册、实际调不动"的工具跑）：
 * 1. 组里至少有一个 `@ToolDecl` 方法；
 * 2. 每个工具必须有 `key` / `title` / `description` / `params` / `config`，类别与作用域可从组级继承；
 * 3. 组内 key 不重复（全局重复由注册机再查一次）；
 * 4. `precheck` / `normalize` 指向的方法必须真实存在；
 * 5. 自定义事件声明合法（名字组内唯一、标题与说明非空、mode 合法），见 `tool-event.ts`。
 */

/** 工具组类的形状：只要有带 `@ToolDecl` 的方法就是（成员类型由各自实现守） */
export type AgentToolGroup = object

/** 取实例上的方法并绑定（装饰器登记的是方法名） */
const bound = <T>(instance: AgentToolGroup, name: string, label: string): T => {
  const fn = (instance as Record<string, unknown>)[name]
  if (typeof fn !== 'function') {
    throw new Error(`工具组 ${instance.constructor.name} 的 ${label} 指向 ${name}，但它不是方法`)
  }
  return (fn as (...args: unknown[]) => unknown).bind(instance) as T
}

/** 合并组级默认值与单个工具的声明（工具自己的值优先；委派类隐含不许子 agent 用） */
const mergeDecl = (group: ToolGroupMeta, decl: ToolDeclMeta): ToolDeclMeta => ({
  ...decl,
  ...(decl.child === undefined && group.child !== undefined ? { child: group.child } : {}),
  ...(decl.delegation === true && decl.child === undefined ? { child: 'deny' } : {}),
})

/** 组装一个工具（校验 + 绑定方法） */
const buildOne = (
  instance: AgentToolGroup,
  methodName: string,
  decl: ToolDeclMeta,
  group: ToolGroupMeta,
): ToolSpec => {
  const className = instance.constructor.name
  const meta = mergeDecl(group, decl)
  const at = `${className}.${methodName}`
  if (!meta.key?.trim()) throw new Error(`工具组 ${at} 的 @ToolDecl 缺少 key`)
  if (!meta.title?.trim()) throw new Error(`工具组 ${at}（${meta.key}）缺少标题`)
  if (!meta.description?.trim()) throw new Error(`工具组 ${at}（${meta.key}）缺少说明`)
  if (!meta.params) throw new Error(`工具组 ${at}（${meta.key}）缺少 params（参数契约）`)
  if (!meta.config) throw new Error(`工具组 ${at}（${meta.key}）缺少 config（配置契约）`)
  const category = meta.category ?? group.category
  const scope = meta.scope ?? group.scope
  if (!category) {
    throw new Error(`工具组 ${at}（${meta.key}）没有类别：在 @ToolDecl 或 @ToolGroup 里给 category`)
  }
  if (!scope) {
    throw new Error(`工具组 ${at}（${meta.key}）没有作用域：在 @ToolDecl 或 @ToolGroup 里给 scope`)
  }

  return {
    key: meta.key,
    title: meta.title,
    description: meta.description,
    category,
    scope,
    ...(meta.delegation === true ? { delegation: true } : {}),
    ...(meta.child ? { child: meta.child } : {}),
    ...(meta.paginate ? { paginate: meta.paginate } : {}),
    params: meta.params,
    // 给模型看的那一份 = 原契约 + 引擎注入的必填 `reason`（工具作者不用自己写，见 `call-reason.ts`）
    modelParams: withCallReason(meta.params),
    ...(meta.result ? { result: meta.result } : {}),
    config: meta.config,
    ...(meta.secrets ? { secrets: meta.secrets } : {}),
    ...(meta.secretFields ? { secretFields: meta.secretFields } : {}),
    // 事件声明归一化：名字 / 标题 / 说明 / mode 校验在这里，payload 契约同时转出 JSON Schema 镜像
    events: normalizeToolEventDecls(meta.events, `工具组 ${at}（${meta.key}）`),
    // 执行体 = 这个方法本身（声明与实现同一处）
    exec: (input: unknown, ctx: never) =>
      bound<(input: unknown, ctx: never) => Promise<unknown>>(
        instance,
        methodName,
        '@ToolDecl 方法',
      )(input, ctx),
    ...(meta.precheck
      ? {
          precheck: (input: unknown, ctx: never) =>
            bound<(input: unknown, ctx: never) => Promise<string | null> | string | null>(
              instance,
              meta.precheck as string,
              'precheck',
            )(input, ctx),
        }
      : {}),
    ...(meta.normalize
      ? {
          normalize: (config: never, caps: never) =>
            bound<(config: never, caps: never) => never>(
              instance,
              meta.normalize as string,
              'normalize',
            )(config, caps),
        }
      : {}),
  } as ToolSpec
}

/**
 * 把一个**工具组实例**拆成 1..n 个工具声明。
 *
 * 注册机对每个实例调用它；组内 key 重复、缺声明、钩子方法不存在都在这里抛错（启动期）。
 */
export const buildToolSpecs = (instance: AgentToolGroup): ToolSpec[] => {
  const className = instance.constructor.name
  const decls = readToolDecls(instance.constructor)
  const group = readToolGroup(instance.constructor)
  const methodNames = Object.keys(decls)
  if (methodNames.length === 0) {
    throw new Error(`工具组 ${className} 没有任何 @ToolDecl 方法：一个工具组至少要交出一个工具`)
  }
  const specs = methodNames.map((methodName) =>
    buildOne(instance, methodName, decls[methodName], group),
  )
  const seen = new Set<string>()
  for (const spec of specs) {
    if (seen.has(spec.key)) {
      throw new Error(`工具组 ${className} 内部 key 重复：${spec.key}`)
    }
    seen.add(spec.key)
  }
  return specs
}
