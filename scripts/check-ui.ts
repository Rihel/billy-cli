/**
 * 前端约定守卫（把「前端质量门 + 组件库目录约定」变成可执行检查）。
 *
 * 背景：后端有 `check:inject`（DI 铁律）与 `check:scaffold`（模板漂移）两道守卫，
 * 前端此前**一道也没有** —— 约定只写在 skill 里，靠人眼遵守。本脚本补上前端那一道。
 *
 * 两条不变量：
 *
 *  A. **自有组件导出完整性**：`packages/ui/src/components/*.{ts,tsx}`（不含 shadcn 管理的
 *     `components/ui/` 子目录）每个文件都必须在 `packages/ui/src/index.ts` 的「自有组件」区段导出。
 *     失败意味着「写了组件没导出」，下一个人搜不到就会再造一个。
 *     `components/ui/*` 不检查：重型组件（chart / carousel / command 等）刻意走子路径按需引入。
 *
 *  B. **前端包质量脚本齐备**：凡是依赖 `next` 的 `apps/*`（含 `pnpm cli -t client` 生成的新前端）
 *     与 `packages/ui`，都必须声明 `typecheck` 脚本。失败意味着新前端包漏网 —— 根 `pnpm typecheck`
 *     管不到它，类型错误会在「门都绿了」的假象下合入。
 *
 * 用法：`pnpm check:ui`（非零退出码表示存在违例）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** UI 包根目录（相对 cwd） */
const UI_ROOT = 'packages/ui'
/** 前端应用扫描根目录（相对 cwd） */
const APPS_ROOT = 'apps'

export interface UiViolation {
  /** 'export' = 自有组件未导出；'script' = 前端包缺 typecheck 脚本 */
  kind: 'export' | 'script'
  /** 涉及的包 / 文件（相对 cwd） */
  target: string
  detail: string
}

/** 读取并解析 package.json（不存在返回 null） */
function readPackageJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`${path} 解析失败：${String(error)}`)
  }
}

/** A. 自有组件是否都在 index.ts 导出 */
export function scanOwnComponentExports(cwd = process.cwd()): UiViolation[] {
  const componentsDir = join(cwd, UI_ROOT, 'src/components')
  const indexPath = join(cwd, UI_ROOT, 'src/index.ts')
  if (!existsSync(componentsDir) || !existsSync(indexPath)) return []

  const indexSource = readFileSync(indexPath, 'utf8')
  const violations: UiViolation[] = []

  for (const entry of readdirSync(componentsDir)) {
    const full = join(componentsDir, entry)
    // 只查自有组件：跳过 shadcn 管理的 ui/ 子目录与 hooks 无关目录
    if (statSync(full).isDirectory()) continue
    if (!/\.(ts|tsx)$/.test(entry)) continue

    // 导出写法按包内约定带扩展名（`#components/xxx.tsx`），故整体匹配文件引用
    if (!indexSource.includes(`#components/${entry}`)) {
      violations.push({
        kind: 'export',
        target: relative(cwd, full),
        detail: `未在 ${UI_ROOT}/src/index.ts 导出（应加 export * from "#components/${entry}"）`,
      })
    }
  }

  return violations
}

/** B. 前端包（apps/* 与 @repo/ui）是否都声明了 typecheck 脚本 */
export function scanFrontendPackages(cwd = process.cwd()): UiViolation[] {
  const violations: UiViolation[] = []
  const targets: string[] = []

  const appsDir = join(cwd, APPS_ROOT)
  if (existsSync(appsDir)) {
    for (const entry of readdirSync(appsDir)) {
      const full = join(appsDir, entry)
      if (!statSync(full).isDirectory()) continue
      targets.push(join(full, 'package.json'))
    }
  }
  targets.push(join(cwd, UI_ROOT, 'package.json'))

  for (const target of targets) {
    const pkg = readPackageJson(target)
    if (!pkg) continue

    const dependencies = (pkg.dependencies ?? {}) as Record<string, string>
    const isFrontend = pkg.name === '@repo/ui' || 'next' in dependencies
    if (!isFrontend) continue

    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    if (!scripts.typecheck) {
      violations.push({
        kind: 'script',
        target: relative(cwd, target),
        detail: '前端包缺少 typecheck 脚本（根 pnpm typecheck 会漏掉它）',
      })
    }
  }

  return violations
}

/** 汇总全部前端约定违例 */
export function scanFrontendConventions(cwd = process.cwd()): UiViolation[] {
  return [...scanOwnComponentExports(cwd), ...scanFrontendPackages(cwd)]
}

/** CLI 入口：非零退出码表示存在违例 */
function main(): void {
  const violations = scanFrontendConventions()
  if (violations.length === 0) {
    console.log('[check:ui] ✅ 自有组件导出完整 / 前端包质量脚本齐备，无违例')
    return
  }
  console.error(`[check:ui] ❌ 发现 ${violations.length} 处违例：`)
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.target}  ${v.detail}`)
  }
  console.error(
    '\n提示：自有组件必须从 packages/ui/src/index.ts 导出；前端包必须声明 typecheck 脚本（见 docs/design/frontend-foundation.md）。',
  )
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
