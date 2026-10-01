import type { z } from 'zod'
import type {
  ToolCategoryValue,
  ToolEnvCaps,
  ToolScopeValue,
  ToolSecretField,
} from './tools.types.js'

/**
 * **工具 DSL 的装饰器**（设计 §5.2）：声明写在类上，执行体写在方法上。
 *
 * 为什么用装饰器 + 类，而不是"构造器里拼一个对象"：
 * 1. **一个工具就是一个 `@Injectable()` 类** —— 依赖（仓储 / 命令执行器 / 日志 / 其它 bean）
 *    全部走构造器注入，与业务代码同一条链路，不需要在装配处手工 `new`；
 * 2. **声明与实现同处一个文件、一眼看完**：类上的 `@ToolDecl` 是它"是什么"，方法上的
 *    `@ToolExecute` 是它"怎么做"；
 * 3. **装配期校验有依据**：注册机从元数据里读声明，缺声明 / 缺执行体 / 配置默认值没给全
 *    都是**启动即失败**（而不是等用户提问时才发现某个能力静默缺失）。
 *
 * 三个方法级装饰器是可选的（`@ToolPrecheck` / `@ToolNormalize`），语义见各自的文档注释。
 */

/** 类级声明的元数据键（`Reflect` 元数据；用 Symbol 避免与其它库撞名） */
export const TOOL_DECL_KEY = Symbol.for('billy.tool.decl')
/** 执行体的方法名 */
export const TOOL_EXEC_KEY = Symbol.for('billy.tool.exec')
/** 只读前置条件的方法名 */
export const TOOL_PRECHECK_KEY = Symbol.for('billy.tool.precheck')
/** 配置归一化的方法名 */
export const TOOL_NORMALIZE_KEY = Symbol.for('billy.tool.normalize')

/** zod 契约的宽类型（装饰器只做登记，不在类型层做推导） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = z.ZodType<any>

/**
 * 类级声明：这个工具**是什么**（不可变的部分，代码是唯一事实源）。
 *
 * 注意：`params` / `config` / `secrets` 是同一文件里定义的 zod 常量
 * （**不能**引用本类的 static —— 装饰器在类定义期求值，那时 static 还没初始化）。
 */
export interface ToolDeclMeta<C = unknown, I = unknown, O = unknown> {
  /** 名称：稳定对外标识（取自 `tool-keys.ts`，禁止裸字符串） */
  key: string
  /** 人读标题（提示词列举 + 后台列表） */
  title: string
  /** 唯一一份说明：是什么 / 什么时候用 / 什么时候不用 / 纪律（模型选工具看到的也是它） */
  description: string
  /** 类别：`core`（运行时能力）/ `business`（绑定业务模块） */
  category: ToolCategoryValue
  /** 默认作用域（库里可覆盖） */
  scope: ToolScopeValue
  /** 委派类工具（创建 / 指挥子 agent）：子 agent 工具面要把它们排除 */
  delegation?: boolean
  /** 子 agent 能不能用（默认能；`delegation` 隐含不能） */
  child?: 'allow' | 'deny'
  /** 声明"我会返回大结果"才分页（不声明就不套这一层） */
  paginate?: { readonly pageBytes: number }
  /** 参数契约（给模型的 JSON Schema 由它生成） */
  params: AnySchema
  /** 出参契约（可选；标准测试集用它校验实现有没有守约） */
  result?: AnySchema
  /**
   * 配置契约：**每个字段都必须用 zod `.default()` 给出默认值**。
   *
   * 代码默认值由 `config.parse({})` 得到（不单列 `defaults`，单列就会与 schema 漂移）；
   * `parse({})` 失败说明默认值没给全 —— 注册机在**启动期**就报错。
   */
  config: AnySchema
  /** 秘钥契约：字段一律可选、**没有默认值**（默认状态是"未配置"） */
  secrets?: AnySchema
  /** 秘钥字段元信息（页面渲染 + "缺哪个"的结论文案） */
  secretFields?: readonly ToolSecretField[]
}

/** 类级装饰器：声明这个工具是什么（一个工具类必须且只能有一个） */
export const ToolDecl =
  <C = unknown, I = unknown, O = unknown>(meta: ToolDeclMeta<C, I, O>) =>
  (target: object): void => {
    Reflect.defineMetadata(TOOL_DECL_KEY, meta, target)
  }

/**
 * 方法级装饰器：**执行体**（一个工具类必须且只能有一个）。
 *
 * 入参：归一化后的入参 + 调用上下文（配置 / 信封 / 日志 / 时钟 / 取消信号）。
 * 只写业务动作 —— 开关、边界、分页、审计都在网关插件里（见设计 §5.4）。
 */
export const ToolExec =
  (): MethodDecorator => (target, propertyKey): void => {
    Reflect.defineMetadata(TOOL_EXEC_KEY, propertyKey, target.constructor)
  }

/**
 * 方法级装饰器：**只读前置条件**（可选）。
 *
 * 返回一句拒绝理由（模型能读懂、能改），或 `null` 表示通过。
 * 必须**只读**：它失败时不该留下任何副作用。需要查库可以（依赖由构造器注入），但不要写。
 */
export const ToolPrecheck =
  (): MethodDecorator => (target, propertyKey): void => {
    Reflect.defineMetadata(TOOL_PRECHECK_KEY, propertyKey, target.constructor)
  }

/**
 * 方法级装饰器：**配置归一化**（可选）。
 *
 * 纯函数：把合并后的配置夹到部署上限（`ToolEnvCaps`），或计算派生值。
 * 于是"工具自己看到的配置"永远已经是安全取值（例：`run-command` 把时长夹到 env 上限）。
 */
export const ToolNormalize =
  (): MethodDecorator => (target, propertyKey): void => {
    Reflect.defineMetadata(TOOL_NORMALIZE_KEY, propertyKey, target.constructor)
  }

/** 读类上的声明元数据（注册机用；没有就是漏写 `@ToolDecl`） */
export const readToolDecl = (target: object): ToolDeclMeta | undefined =>
  Reflect.getMetadata(TOOL_DECL_KEY, target) as ToolDeclMeta | undefined

/** 读方法级元数据（注册机用） */
export const readToolMethod = (
  target: object,
  key: symbol,
): string | symbol | undefined =>
  Reflect.getMetadata(key, target) as string | symbol | undefined

/** 归一化钩子的签名（装饰器只登记方法名，签名由实现方守） */
export type ToolNormalizeFn<C> = (config: C, caps: ToolEnvCaps) => C
