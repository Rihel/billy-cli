import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AppConfigFacade,
  ConfigLoadError,
  ConfigValidationError,
  consulConfigLoader,
  envConfigLoader,
  listBuiltInConfigLoaders,
  memoryConfigLoader,
  registerConfigLoader,
  resolveConfigLoader,
} from '../src/foundation/config/index.js'

const schema = z.object({
  port: z.number().default(9989),
  redis: z.object({
    url: z.string().default('redis://localhost:6379/0'),
    db: z.number().default(0),
  }),
  name: z.string().min(2),
})

const load = (loader: unknown) =>
  AppConfigFacade.initial({ schema, loader: loader as never })

afterEach(() => {
  AppConfigFacade.reset()
})

describe('配置 loader（可插拔来源）', () => {
  it('内置 loader：env / memory / consul', () => {
    expect(listBuiltInConfigLoaders().sort()).toEqual(['consul', 'env', 'memory'])
    expect(resolveConfigLoader('env').name).toBe('env')
    expect(
      resolveConfigLoader('consul', { baseURL: 'http://c', key: 'k' }).name,
    ).toBe('consul')
  })

  it('未注册的 loader 名字：报错并列出可用项', () => {
    expect(() => resolveConfigLoader('nacos')).toThrow(ConfigLoadError)
    expect(() => resolveConfigLoader('nacos')).toThrow(/未注册的配置 loader/)
  })

  it('支持应用注册自定义 loader（按名字引用）', () => {
    registerConfigLoader('custom-test', () => ({
      name: 'custom-test',
      load: () => ({ name: 'from-custom' }),
    }))
    expect(resolveConfigLoader('custom-test').name).toBe('custom-test')
  })
})

describe('AppConfigFacade（shape 由应用自定义）', () => {
  it('memory loader：校验通过并补全（含嵌套）默认值', async () => {
    const config = await load(memoryConfigLoader({ name: 'billy' }))
    expect(config).toEqual({
      name: 'billy',
      port: 9989,
      redis: { url: 'redis://localhost:6379/0', db: 0 },
    })
  })

  it('env loader：经 mapEnv 映射为应用的嵌套 shape', async () => {
    const config = await load(
      envConfigLoader({ mapEnv: () => ({ name: 'from-env', port: 1234 }) }),
    )
    expect(config.name).toBe('from-env')
    expect(config.port).toBe(1234)
  })

  it('名字形式：loader 名 + loaderOptions', async () => {
    const config = await AppConfigFacade.initial({
      schema,
      loader: 'memory',
      loaderOptions: { name: 'by-name' },
    })
    expect(config.name).toBe('by-name')
  })

  it('自定义 loader：实现接口即可，shape 不变', async () => {
    const config = await load({
      name: 'inline',
      load: async () => ({ name: 'inline-ok', port: 3000 }),
    })
    expect(config.port).toBe(3000)
  })

  it('校验失败：抛 ConfigValidationError 且带字段路径', async () => {
    const error = await load(memoryConfigLoader({ name: 'b' })).catch((e) => e)
    expect(error).toBeInstanceOf(ConfigValidationError)
    expect((error as Error).message).toContain('配置校验失败')
    expect((error as Error).message).toContain('name')
  })

  it('来源不可用：抛 ConfigLoadError（含 loader 名）', async () => {
    const error = await load(
      consulConfigLoader({ baseURL: '', key: '' }),
    ).catch((e) => e)
    expect(error).toBeInstanceOf(ConfigLoadError)
    expect((error as Error).message).toContain('consul')
  })

  it('幂等：重复 initial 返回同一份；getConfig 同步可读', async () => {
    const first = await load(memoryConfigLoader({ name: 'once' }))
    const second = await load(memoryConfigLoader({ name: 'twice' }))
    expect(second).toBe(first)
    expect(AppConfigFacade.isInitialized()).toBe(true)
    expect(AppConfigFacade.getConfig<typeof first>().name).toBe('once')
  })

  it('未初始化即读取：抛 AppConfigNotInitializedError', () => {
    expect(() => AppConfigFacade.getConfig()).toThrow(/配置尚未加载/)
  })
})
