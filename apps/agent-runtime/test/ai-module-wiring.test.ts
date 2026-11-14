import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { AiModule } from '../src/modules/ai/ai.module.js'

/**
 * **组合根的静态守卫**（这一条是被真实 bug 逼出来的）。
 *
 * 症状：`exports` 里写了一个**没有在 `providers` 里提供**的 token（`ToolRegistry` 的 Symbol），
 * 类型检查全绿、单测全绿（单测手工装配，不走模块），**只有启动时才炸**：
 * `UnknownExportException: Nest cannot export a provider that is not a part of the module`。
 *
 * 所以这里不启动应用，只读 Nest 存在类上的元数据，把"导出了没提供的东西"这类装配错误
 * 在单测阶段就拦下来（`imports` 里转出去的模块不查，那是 Nest 自己的事）。
 */
const metadata = (key: string): unknown[] =>
  (Reflect.getMetadata(key, AiModule) as unknown[] | undefined) ?? []

/** 把 provider 写法归一成"它对外暴露的 token" */
const providedTokens = (): unknown[] =>
  metadata('providers').map((provider: unknown) => {
    if (typeof provider === 'function') return provider
    const entry = provider as { provide?: unknown; useExisting?: unknown }
    // `useExisting` 暴露的是 provide 那个 token（两者都要算进"已提供"）
    return entry.provide ?? entry
  })

describe('AiModule 组合根：装配自洽', () => {
  it('`exports` 里的每一个 token 都在 `providers` 里提供过', () => {
    const provided = new Set(providedTokens())
    const exported = metadata('exports')
    const missing = exported.filter((token) => !provided.has(token))
    expect(
      missing.map((token) => String(token)),
      '导出但没有提供 —— 只会在启动时报 UnknownExportException',
    ).toEqual([])
  })

  it('`controllers` 非空（模块要么提供能力、要么暴露路由）', () => {
    expect(metadata('controllers').length).toBeGreaterThan(0)
  })
})
