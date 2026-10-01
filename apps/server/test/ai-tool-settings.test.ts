import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clampLimits, codeDefaults, mergeToolSettings } from '../src/modules/ai/tools/tool.settings.js'
import type { ToolConfigRow } from '../src/modules/ai/tools/tool.config.ports.js'
import type { ToolEnvCaps, ToolSpec } from '../src/modules/ai/tools/tools.types.js'

/**
 * 配置三级合并（设计 §5.5）：`env 硬上限 夹紧 ( 库里的值 ?? 代码默认值 )`。
 *
 * 这是"配置入库 + 免重启"的规则核心，所以**脱离数据库**单测（纯函数）。
 */
const caps: ToolEnvCaps = { pageBytesMax: 1024, maxPagesPerTurnMax: 3 }

const spec: ToolSpec<{ timeoutMs: number; workDir: string; enabled: boolean }> = {
  key: 'demo',
  title: '演示工具',
  description: '只用于测试的声明',
  category: 'core',
  scope: 'all',
  params: z.object({}),
  config: z.object({
    timeoutMs: z.number().int().positive().default(1000),
    workDir: z.string().default(''),
    enabled: z.boolean().default(true),
  }),
  exec: async () => ({}),
}

const row = (over: Partial<ToolConfigRow> = {}): ToolConfigRow => ({
  enabled: true,
  scope: 'all',
  allowedAgents: null,
  config: null,
  limits: null,
  title: null,
  description: null,
  source: 'seed',
  version: 'v1',
  secrets: {},
  secretHints: {},
  ...over,
})

describe('工具配置合并（纯函数）', () => {
  it('代码默认值来自 schema：`config.parse({})` 成功才说明默认值给全了', () => {
    expect(codeDefaults(spec)).toEqual({ timeoutMs: 1000, workDir: '', enabled: true })
  })

  it('默认值没给全 → 抛错（启动期就该炸，而不是运行时才发现）', () => {
    const bad: ToolSpec<{ required: string }> = {
      ...spec,
      key: 'bad',
      config: z.object({ required: z.string() }),
    }
    expect(() => codeDefaults(bad)).toThrowError(/没有给全默认值/)
  })

  it('库里没有行：生效值 = 代码默认值，版本是 `code-default`', () => {
    const settings = mergeToolSettings(spec, null, caps)
    expect(settings.config).toEqual({ timeoutMs: 1000, workDir: '', enabled: true })
    expect(settings.version).toBe('code-default')
    expect(settings.source).toBe('seed')
    expect(settings.enabled).toBe(true)
  })

  it('库里改过的值生效（免重启的根据）', () => {
    const settings = mergeToolSettings(spec, row({ config: { timeoutMs: 2500 } }), caps)
    expect(settings.config.timeoutMs).toBe(2500)
    // 没给过的字段仍用默认值（稀疏合并）
    expect(settings.config.workDir).toBe('')
  })

  it('`undefined` 视为"没给"，不会把默认值抹掉', () => {
    const settings = mergeToolSettings(spec, row({ config: { timeoutMs: undefined } }), caps)
    expect(settings.config.timeoutMs).toBe(1000)
  })

  it('限额夹紧：库里的值再大也突破不了 env 上限', () => {
    const limits = clampLimits({ pageBytes: 999999, maxPagesPerTurn: 99, maxPerTurn: 5 }, caps)
    expect(limits.pageBytes).toBe(1024)
    expect(limits.maxPagesPerTurn).toBe(3)
    expect(limits.maxPerTurn).toBe(5)
  })

  it('`normalize`（工具自己的夹紧钩子）在合并之后执行', () => {
    const withNormalize: ToolSpec<{ timeoutMs: number; workDir: string; enabled: boolean }> = {
      ...spec,
      key: 'demo-normalize',
      normalize: (config, envCaps) => ({
        ...config,
        timeoutMs: Math.min(config.timeoutMs, 500),
        workDir: config.workDir || envCaps.command?.workDir || '',
      }),
    }
    const settings = mergeToolSettings(withNormalize, row({ config: { timeoutMs: 9999 } }), {
      ...caps,
      command: { enabled: true, timeoutMsMax: 500, maxOutputBytesMax: 1, workDir: '/srv' },
    })
    expect(settings.config.timeoutMs).toBe(500)
    expect(settings.config.workDir).toBe('/srv')
  })

  it('秘钥：没有默认值，缺就是未配置；提示串可读而明文只在内存里', () => {
    const settings = mergeToolSettings(
      spec,
      row({ secrets: { token: 'plain-secret' }, secretHints: { token: 'pla…cret' } }),
      caps,
    )
    expect(settings.secret('token')).toBe('plain-secret')
    expect(settings.secretHint('token')).toBe('pla…cret')
    expect(settings.secret('missing')).toBeNull()
  })

  it('文案覆盖：库里给了就用库里的，`source` 如实反映是谁改的', () => {
    const settings = mergeToolSettings(
      spec,
      row({ title: '  改过的标题  ', description: '改过的说明', source: 'manual' }),
      caps,
    )
    expect(settings.title).toBe('改过的标题')
    expect(settings.description).toBe('改过的说明')
    expect(settings.source).toBe('manual')
  })

  it('作用域与开关从库里来；库里没给就用声明的默认', () => {
    expect(mergeToolSettings(spec, null, caps).scope).toBe('all')
    expect(mergeToolSettings(spec, row({ enabled: false, scope: 'admin' }), caps)).toMatchObject({
      enabled: false,
      scope: 'admin',
    })
  })
})
