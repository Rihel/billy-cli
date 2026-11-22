import { describe, expect, it } from 'vitest'
import { findMastraViolations } from '../../../scripts/check-mastra-boundary.js'

const file = (name: string): string => `apps/agent-runtime/src/modules/ai/tools/${name}.ts`

describe('Mastra 边界守卫（词法扫描）', () => {
  it('单双引号、动态 import、require、export from 都能抓', () => {
    const violations = findMastraViolations({
      [file('single')]: "import { Agent } from '@mastra/core/agent'",
      [file('double')]: 'import { Agent } from "@mastra/core/agent"',
      [file('dynamic')]: "const m = await import('@mastra/core/agent')",
      [file('require')]: "const m = require('@mastra/core/agent')",
      [file('export')]: "export * from '@mastra/core'",
    })

    expect(violations.map((item) => item.file).sort()).toEqual([
      file('double'),
      file('dynamic'),
      file('export'),
      file('require'),
      file('single'),
    ])
  })

  it('注释里的示例不算依赖', () => {
    const violations = findMastraViolations({
      [file('comment')]:
        '// import { Agent } from \'@mastra/core/agent\'\n/* import("@mastra/core") */\nexport const ok = 1',
    })

    expect(violations).toEqual([])
  })
})
