import { ZodError, type ZodType } from 'zod'
import {
  AppConfigNotInitializedError,
  ConfigLoadError,
  ConfigValidationError,
  type AppConfigInitialOptions,
  type ConfigLoader,
  type LoadedAppConfig,
} from './config.loader.js'
import { resolveConfigLoader } from './loaders/index.js'
import { mergeSchemaDefaults } from './schema-defaults.js'

/**
 * 应用配置统一入口（shape 由应用自定义，来源由 loader 决定）。
 *
 * 为什么需要它：模块装饰器（含 `ConfigModule.forRoot` 的 `load` 工厂、各模块 `forRootAsync` 工厂）
 * 的求值**早于** `main()` 里的配置加载；而加载（尤其 Consul）是异步的。因此约定：
 * 在 `NestFactory.create` **之前**调用一次 `initial()` 完成「加载 → 校验 → 补默认值 → 缓存」，
 * 之后所有消费点（Nest 的 `ConfigService` / 业务代码）同步读取 `getConfig()`。
 *
 * @example env loader
 * await AppConfigFacade.initial({
 *   schema: serverAppConfigSchema,
 *   loader: envConfigLoader({ envFileName: '.env', mapEnv: mapServerEnv }),
 * })
 *
 * @example consul loader（换来源不改 shape）
 * await AppConfigFacade.initial({
 *   schema: serverAppConfigSchema,
 *   loader: 'consul',
 *   loaderOptions: { baseURL: 'http://consul:8500', key: 'billy/server' },
 * })
 */
export class AppConfigFacade {
  private static config?: Record<string, unknown>
  private static loadPromise?: Promise<Record<string, unknown>>

  /** 加载并缓存配置（幂等：重复调用返回同一份） */
  static async initial<Schema extends ZodType>(
    options: AppConfigInitialOptions<Schema>,
  ): Promise<LoadedAppConfig<Schema>> {
    if (AppConfigFacade.config) {
      return AppConfigFacade.config as LoadedAppConfig<Schema>
    }
    AppConfigFacade.loadPromise ??= AppConfigFacade.load(options)
    return AppConfigFacade.loadPromise as Promise<LoadedAppConfig<Schema>>
  }

  /** 同步读取已加载配置（未初始化即抛错，避免静默读到空配置） */
  static getConfig<Config = Record<string, unknown>>(): Config {
    if (!AppConfigFacade.config) {
      throw new AppConfigNotInitializedError()
    }
    return AppConfigFacade.config as Config
  }

  static isInitialized(): boolean {
    return AppConfigFacade.config !== undefined
  }

  /** 仅供测试使用：清空缓存 */
  static reset(): void {
    AppConfigFacade.config = undefined
    AppConfigFacade.loadPromise = undefined
  }

  private static async load<Schema extends ZodType>(
    options: AppConfigInitialOptions<Schema>,
  ): Promise<Record<string, unknown>> {
    const loader: ConfigLoader =
      typeof options.loader === 'string'
        ? resolveConfigLoader(options.loader, options.loaderOptions)
        : options.loader

    let raw: Record<string, unknown>
    try {
      raw = await loader.load()
    } catch (cause) {
      throw new ConfigLoadError(
        `配置来源加载失败（${loader.name}）：${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      )
    }

    try {
      // 先把 schema 声明的嵌套对象默认值物化出来，再交给 Zod 校验/补全
      // （父键整体缺失时 Zod 不会补全嵌套对象，见 schema-defaults.ts）
      const config = options.schema.parse(
        mergeSchemaDefaults(raw, options.schema),
      ) as Record<string, unknown>
      AppConfigFacade.config = config
      return config
    } catch (error) {
      if (error instanceof ZodError) {
        const detail = error.issues
          .map(
            (issue) =>
              `- ${issue.path.join('.') || '(root)'} : ${issue.message}`,
          )
          .join('\n')
        throw new ConfigValidationError(`配置校验失败：\n${detail}`, error)
      }
      throw error
    }
  }
}

export {
  AppConfigNotInitializedError,
  ConfigLoadError,
  ConfigValidationError,
} from './config.loader.js'
export type {
  AppConfigInitialOptions,
  ConfigLoader,
  ConfigLoaderFactory,
  LoadedAppConfig,
} from './config.loader.js'
export {
  getRegisteredConfigLoader,
  listRegisteredConfigLoaders,
  registerConfigLoader,
} from './config.loader.js'
export {
  consulConfigLoader,
  envConfigLoader,
  listBuiltInConfigLoaders,
  memoryConfigLoader,
  resolveConfigLoader,
  type ConsulConfigLoaderOptions,
  type EnvConfigLoaderOptions,
} from './loaders/index.js'
