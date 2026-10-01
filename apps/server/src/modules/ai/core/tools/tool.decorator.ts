import type { z } from 'zod'
import type {
  ToolCategoryValue,
  ToolEventDeclMeta,
  ToolScopeValue,
  ToolSecretField,
} from './tools.types.js'

/**
 * **工具组 DSL 的装饰器**（设计 §5.2）：一个工具组一个类，**组内一个方法一个工具**。
 *
 * ```
 * @Injectable()
 * @ToolGroup({ category: 'core', child: 'deny' })   // 组级：共同默认值（可选）
 * export class PlannerTools {
 *   constructor(@Inject(PlannerStore) private readonly store: PlannerStore) {}
 *
 *   @ToolDecl({ key, title, description, params, config })   // 方法级 = 一个工具
 *   async create(input, ctx) { … }
 *
 *   @ToolDecl({ key: …, precheck: 'checkGoal' })
 *   async reorder(input, ctx) { … }
 * }
 * ```
 *
 * 为什么这样分两层：
 * - **组 = 一类能力的集合**（规划四件事、命令执行、子 agent…）—— 共享依赖（构造器注入一次）、
 *   共享默认元数据（category / scope / child），于是同类工具不会各写一遍；
 * - **方法 = 一个工具**（声明 + 执行体同一处）—— 模型看到的工具与代码里的方法一一对应，
 *   加一个工具就是加一个方法，不新增文件也不新增装配；
 * - **单工具组也照这个写法**（一个方法）：形状只有一种，不必区分"单工具类"和"工具组"。
 *
 * 三个方法级钩子是**按方法名**挂在声明里的（`precheck` / `normalize`），不另设装饰器：
 * 一个工具最多各有一个，写在同一条声明里最直观，注册机在**启动期**校验方法确实存在
 * （写错名字起不来，而不是运行时静默失效）。
 */

/** 组级声明的元数据键 */
export const TOOL_GROUP_KEY = Symbol.for('billy.tool.group')
/** 组内所有工具声明的元数据键（值是 `{ 方法名 → 声明 }`） */
export const TOOL_DECLS_KEY = Symbol.for('billy.tool.decls')

/** zod 契约的宽类型（装饰器只做登记，不在类型层做推导） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = z.ZodType<any>

/**
 * 组级声明：给组内工具**共同默认值**（每个工具可以在自己的 `@ToolDecl` 里覆盖）。
 *
 * 只放"同类工具都一样"的那几项；标题 / 说明 / 参数 / 配置是**每个工具各不相同**的，
 * 必须写在各自的 `@ToolDecl` 里（写错地方就报错，见 `tool.class.ts` 的校验）。
 */
export interface ToolGroupMeta {
  /** 类别：`core`（运行时能力）/ `business`（绑定业务模块） */
  category?: ToolCategoryValue
  /** 默认作用域（库里可覆盖） */
  scope?: ToolScopeValue
  /** 子 agent 能不能用（默认能） */
  child?: 'allow' | 'deny'
}

/** 单个工具的声明：这个方法**是什么工具** */
export interface ToolDeclMeta<C = unknown, I = unknown, O = unknown> {
  /** 名称：稳定对外标识（取自 `tool-keys.ts`，禁止裸字符串） */
  key: string
  /** 人读标题（提示词列举 + 后台列表） */
  title: string
  /** 唯一一份说明：是什么 / 什么时候用 / 什么时候不用 / 纪律（模型选工具看到的也是它） */
  description: string
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
  /**
   * 秘钥契约：字段一律可选、**没有默认值**（默认状态是"未配置"）
   */
  secrets?: AnySchema
  /** 秘钥字段元信息（页面渲染 + "缺哪个"的结论文案） */
  secretFields?: readonly ToolSecretField[]
  /**
   * **自定义事件**声明（设计 §5.17）：这个工具运行时会往父流里吐哪些过程事件。
   *
   * 声明后执行体用 `ctx.emit(name, payload?)` 发（未声明的名字发不出去）；
   * 名字组内唯一、payload 契约在启动期归一化成 JSON Schema 镜像入库，管理页只读展示。
   */
  events?: readonly ToolEventDeclMeta[]
  /** 覆盖组级默认值：类别 `core`（运行时能力）/ `business`（绑定业务模块） */
  category?: ToolCategoryValue
  /** 覆盖组级默认值：默认作用域（库里可覆盖） */
  scope?: ToolScopeValue
  /** 覆盖组级默认值：`delegation: true` = 委派类（创建 / 指挥子 agent） */
  delegation?: boolean
  /** 覆盖组级默认值：子 agent 能不能用（`delegation` 隐含不能） */
  child?: 'allow' | 'deny'
  /** 声明"我会返回大结果"才分页（不声明就不套这一层） */
  paginate?: { readonly pageBytes: number }
  /** **只读前置条件**的方法名（可选）：返回一句拒绝理由，或 `null` 表示通过 */
  precheck?: string
  /** **配置归一化**的方法名（可选）：把配置夹到部署上限，纯函数 */
  normalize?: string
}

/**
 * 类级装饰器（可选）：标记这个类是工具组，并给组内工具共同默认值。
 *
 * 不写也行（组内每个 `@ToolDecl` 自带 `category` / `scope`）；写了就不用在每个工具上重复。
 */
export const ToolGroup =
  (meta: ToolGroupMeta = {}) =>
  (target: object): void => {
    Reflect.defineMetadata(TOOL_GROUP_KEY, meta, target)
  }

/**
 * 方法级装饰器：**这个方法是一个工具**（声明 + 执行体同一处）。
 *
 * 方法签名：`(input, ctx) => Promise<出参>`——入参已由网关归一化，ctx 带配置 / 信封 / 日志 /
 * 时钟 / 取消信号。只写业务动作：开关、边界、分页、审计都在网关插件里（设计 §5.4）。
 */
export const ToolDecl =
  <C = unknown, I = unknown, O = unknown>(meta: ToolDeclMeta<C, I, O>) =>
  (target: object, propertyKey: string | symbol): void => {
    const existing = (Reflect.getMetadata(TOOL_DECLS_KEY, target.constructor) ?? {}) as Record<
      string,
      ToolDeclMeta
    >
    existing[String(propertyKey)] = meta as ToolDeclMeta
    Reflect.defineMetadata(TOOL_DECLS_KEY, existing, target.constructor)
  }

/** 读组级元数据（没写 `@ToolGroup` 就是空对象） */
export const readToolGroup = (target: object): ToolGroupMeta =>
  (Reflect.getMetadata(TOOL_GROUP_KEY, target) as ToolGroupMeta | undefined) ?? {}

/** 读组内全部工具声明（`方法名 → 声明`；没有就是漏写 `@ToolDecl`） */
export const readToolDecls = (target: object): Record<string, ToolDeclMeta> =>
  (Reflect.getMetadata(TOOL_DECLS_KEY, target) as Record<string, ToolDeclMeta> | undefined) ?? {}
