/**
 * 工具目录一致性守卫（B1 的可执行版本）。
 *
 * 背景：`packages/tool-catalog/src/generated.ts` 是 gateway 的**运行时工具目录**，
 * 而模型能看到的工具面由它过滤（`GatewayToolCatalog.allowedKeys`）。
 * 新增 `@ToolDecl` 后忘了跑 `pnpm gen:tool-catalog`，工具就会「后台在册、模型调不到」——
 * 2026-11-15 的 `wait-sub-agent` / `sub-agent-list` / `cancel-sub-agent` 就是这个问题。
 *
 * 本脚本用与生成器**同一条代码路径**渲染文本，再与仓库里的生成物逐字节比对；
 * 不一致即失败，并提示重跑命令。
 *
 * 用法：`pnpm check:tool-catalog`（已接进 `pnpm verify` 与 pre-push）。
 */
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { TOOL_CATALOG_PATH, renderToolCatalog } from './generate-tool-catalog.js'

const expected = renderToolCatalog()
const actual = readFileSync(TOOL_CATALOG_PATH, 'utf8')

if (actual !== expected.text) {
  const rel = relative(process.cwd(), TOOL_CATALOG_PATH)
  console.error(
    [
      `✗ 工具目录生成物已过期：${rel}`,
      `  当前源码声明 ${expected.count} 个工具，生成物与声明不一致。`,
      '  修法：pnpm gen:tool-catalog 后提交生成的改动。',
      '  只改注释 / 描述也会导致不一致——凡改 @ToolDecl 都要重跑。',
    ].join('\n'),
  )
  process.exit(1)
}

console.log(`✓ 工具目录一致（${expected.count} 个工具）`)
