import fs from 'node:fs'
import path from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { load as parseYaml } from 'js-yaml'
import {
  ConfigLoadError,
  getRegisteredConfigLoader,
  listRegisteredConfigLoaders,
  type ConfigLoader,
} from '../config.loader.js'

export interface EnvConfigLoaderOptions {
  /** dotenv 文件名（相对 process.cwd()）；提供则先加载该文件 */
  envFileName?: string
  /**
   * 把 `process.env` 映射为配置对象（应用自定义 shape 的适配点）。
   * 缺省原样返回 `{ ...process.env }`（适合 shape 就是扁平键值的场景）。
   */
  mapEnv?: (env: NodeJS.ProcessEnv) => Record<string, unknown>
}

/**
 * env loader：dotenv 文件 + 环境变量。
 *
 * 未提供 `mapEnv` 时原样给出扁平 env；提供则由应用把它映射成嵌套 shape。
 */
export const envConfigLoader = (options: EnvConfigLoaderOptions = {}): ConfigLoader => ({
  name: 'env',
  load: (): Record<string, unknown> => {
    if (options.envFileName) {
      const envFilePath = path.join(process.cwd(), options.envFileName)
      if (fs.existsSync(envFilePath)) {
        loadDotenv({ path: envFilePath, override: true })
      }
    }
    return options.mapEnv ? options.mapEnv(process.env) : { ...process.env }
  },
})

/**
 * memory loader：直接给一份配置对象（单测 / 单进程注入 / 从别处已取好的配置）。
 */
export const memoryConfigLoader = (
  data: Record<string, unknown>,
  name = 'memory',
): ConfigLoader => ({
  name,
  load: () => data,
})

export interface ConsulConfigLoaderOptions {
  /** Consul 基础地址，如 http://localhost:8500 */
  baseURL: string
  /** KV 键，如 `myapp/config` */
  key: string
  /** ACL Token（可选） */
  token?: string
  /** 请求超时毫秒，默认 5000 */
  timeoutMs?: number
  /** KV 内容格式：'yaml'（默认，兼容 JSON）| 'json' */
  format?: 'yaml' | 'json'
}

/**
 * consul loader：读取 Consul KV（raw）并按 yaml / json 解析。
 * 后续换 Nacos / Apollo 等配置中心，照此实现 `ConfigLoader` 即可，应用 shape 不变。
 */
export const consulConfigLoader = (options: ConsulConfigLoaderOptions): ConfigLoader => ({
  name: 'consul',
  load: async (): Promise<Record<string, unknown>> => {
    const { baseURL, key, token, timeoutMs = 5000, format = 'yaml' } = options
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(
        `${baseURL.replace(/\/$/, '')}/v1/kv/${key.replace(/^\//, '')}?raw=true`,
        {
          headers: token ? { 'X-Consul-Token': token } : {},
          signal: controller.signal,
        },
      )
      if (!response.ok) {
        throw new Error(`Consul 返回 HTTP ${response.status}`)
      }
      const text = await response.text()
      return format === 'json'
        ? (JSON.parse(text) as Record<string, unknown>)
        : (parseYaml(text) as Record<string, unknown>)
    } finally {
      clearTimeout(timer)
    }
  },
})

/** 内置 loader：名字 → 工厂（名字引用形式解析用） */
const builtInLoaders: Record<string, (options?: any) => ConfigLoader> = {
  env: (options) => envConfigLoader((options ?? {}) as EnvConfigLoaderOptions),
  memory: (options) => memoryConfigLoader((options ?? {}) as Record<string, unknown>),
  consul: (options) => consulConfigLoader(options as ConsulConfigLoaderOptions),
}

/**
 * 按名字解析 loader：先查内置（env / memory / consul），再查应用注册的自定义 loader。
 * 未注册时抛出 `ConfigLoadError` 并列出可用名字。
 */
export const resolveConfigLoader = (name: string, options?: unknown): ConfigLoader => {
  const factory = builtInLoaders[name] ?? getRegisteredConfigLoader(name)
  if (!factory) {
    throw new ConfigLoadError(
      `未注册的配置 loader：「${name}」。内置：${Object.keys(builtInLoaders).join(' / ')}；已注册：${listRegisteredConfigLoaders().join(' / ') || '无'}`,
    )
  }
  return factory(options)
}

export const listBuiltInConfigLoaders = (): string[] => Object.keys(builtInLoaders)
