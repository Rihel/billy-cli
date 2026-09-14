import { describe, expect, it } from 'vitest'
import { scanInjectDecorators } from '../../scripts/check-inject-decorators'

/**
 * DI 装饰器一致性（工程铁律第 6 条的可执行守卫）。
 *
 * 开发态用 tsx（esbuild）不产出 `design:paramtypes`，由容器装配的类若漏写 `@Inject(token)`，
 * Nest 会**静默注入 `undefined`**（不报错，运行时才炸）。这条守卫把约定变成红灯，
 * 覆盖 `packages/kits/src` 与 `apps/server/src`。
 *
 * 修法见 `docs/dev-logs/` 与 `billy-dev-foundation` 的 `code-conventions.md` 第 5 条。
 */
describe('DI 装饰器一致性', () => {
  it('容器装配的类：构造器参数全部显式 @Inject；providers 里的类都有 @Injectable', () => {
    const violations = scanInjectDecorators()
    const readable = violations.map(
      (v) => `${v.file}:${v.line} [${v.kind}] ${v.detail}`,
    )

    expect(readable).toEqual([])
  })
})
