import type { z, ZodType } from 'zod'

/**
 * 配置加载器：负责从**某一种来源**取出「原始配置对象」。
 *
 * 只做「取」，不做校验/补默认值 —— 校验与默认值由 `AppConfigFacade` 用应用自定义的
 * zod schema 统一完成，因此任何来源都能喂给同一份 shape。
 *
 * 内置：`envConfigLoader` / `memoryConfigLoader` / `consulConfigLoader`；
 * 需要别的来源（Nacos / Apollo / 配置中心 SDK / 测试桩）时实现本接口即可，
 * 也可用 `registerConfigLoader(name, factory)` 注册成可被名字引用的 loader。
 */
export interface ConfigLoader {
  /** loader 名称（日志与报错用） */
  readonly name: string
  /** 取原始配置（未校验）；异步来源返回 Promise */
  load(): Promise<Record<string, unknown>> | Record<string, unknown>
}

/** loader 工厂：名字引用形式 `{ loader: 'env', loaderOptions: {...} }` 使用 */
export type ConfigLoaderFactory<Options = unknown> = (
  options?: Options,
) => ConfigLoader

/** 自定义 loader 注册表（内置三个 loader 不走这里，见 loaders/index.ts） */
const customLoaders = new Map<string, ConfigLoaderFactory>()

/**
 * 注册（或覆盖）一个**按名字引用**的 loader，供应用扩展自有配置来源。
 *
 * @example
 * registerConfigLoader('nacos', (options) => ({
 *   name: 'nacos',
 *   load: () => fetchFromNacos(options as NacosOptions),
 * }))
 */
export const registerConfigLoader = (
  name: string,
  factory: ConfigLoaderFactory,
): void => {
  customLoaders.set(name, factory)
}

export const getRegisteredConfigLoader = (
  name: string,
): ConfigLoaderFactory | undefined => customLoaders.get(name)

export const listRegisteredConfigLoaders = (): string[] => [
  ...customLoaders.keys(),
]

/** 配置加载失败（来源不可用），或 loader 名字未注册 */
export class ConfigLoadError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ConfigLoadError'
  }
}

/** 配置校验失败：schema 不通过（附字段路径） */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/** 配置尚未初始化即被读取（忘记在 bootstrap 前调用 AppConfigFacade.initial） */
export class AppConfigNotInitializedError extends Error {
  constructor() {
    super(
      '配置尚未加载：请在 NestFactory.create 之前调用 AppConfigFacade.initial({ schema, loader })',
    )
    this.name = 'AppConfigNotInitializedError'
  }
}

/** `AppConfigFacade.initial` 入参：shape 由应用自定义，来源由 loader 决定 */
export interface AppConfigInitialOptions<Schema extends ZodType> {
  /** 应用自定义的配置 shape（zod schema：校验 + 补默认值） */
  schema: Schema
  /**
   * 配置来源：
   * - 直接给 `ConfigLoader` 实例（推荐，最显式）：`loader: envConfigLoader({ envFileName: '.env' })`
   * - 或给内置 / 已注册的 loader 名字 + `loaderOptions`：`loader: 'consul', loaderOptions: { baseURL, key }`
   */
  loader: ConfigLoader | string
  /** 名字形式时的 loader 参数 */
  loaderOptions?: unknown
}

/** 已加载配置的类型（由应用 schema 推导） */
export type LoadedAppConfig<Schema extends ZodType> = z.infer<Schema>
