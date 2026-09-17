/**
 * 前端约定守卫（把「前端质量门 + 组件库目录约定 + 设计系统约定」变成可执行检查）。
 *
 * 背景：后端有 `check:inject`（DI 铁律）与 `check:scaffold`（模板漂移）两道守卫，
 * 前端此前**一道也没有** —— 约定只写在 skill 里，靠人眼遵守。本脚本补上前端那一道。
 *
 * 五条不变量：
 *
 *  A. **自有组件导出完整性**：`packages/ui/src/components/` 下的自有组件（不含 shadcn 管理的
 *     `components/ui/` 子目录）每个文件都必须在 `packages/ui/src/index.ts` 的「自有组件」区段导出。
 *     失败意味着「写了组件没导出」，下一个人搜不到就会再造一个。
 *     `components/ui/` 不检查：重型组件（chart / carousel / command 等）刻意走子路径按需引入。
 *
 *  B. **前端包质量脚本齐备**：凡是依赖 `next` 的 `apps/`（含 `pnpm cli -t client` 生成的新前端）
 *     与 `packages/ui`，都必须声明 `typecheck` 脚本。失败意味着新前端包漏网 ——
 *     根 `pnpm typecheck` 管不到它，类型错误会在「门都绿了」的假象下合入。
 *
 *  C. **禁止新增硬编码调色板类**：`packages/ui/src` 与 `apps/<app>/src` 中不得**新增**
 *     `bg-blue-500` / `text-zinc-400` 这类业务调色板类 —— 视觉取值应走设计系统的语义 token
 *     （`bg-primary` / `text-muted-foreground` / `text-success` …，定义在
 *     `packages/ui/src/globals.css`）。
 *     历史存量按文件记入基线（只许减少、不许增加）：一次性全量迁移改动面过大，
 *     故采取「冻结存量 + 禁止新增」，让漂移不再扩散（见 docs/design/design-system.md §2）。
 *
 *  D. **工作区包样式入口可解析**：`apps/<app>/src`、`packages/ui/src` 与
 *     `scripts/cli/templates/files/` 里出现的 `@import "@repo/<pkg>/<路径>.css"`
 *     必须在 `packages/<pkg>/src/<路径>.css` 真实存在。
 *     包改名 / 导出改名后这些引用会**静默失效**（client 模板不在 `check:scaffold` 覆盖范围内，
 *     IDE 入口 `tailwind-ide.css` 也不参与构建，坏了没人发现）。
 *
 *  E. **字体契约一致**：`apps/<app>/src/app/layout.tsx` 与 client 模板的 `next/font` 变量名
 *     必须与 `globals.css` 里字体回退链引用的变量一致 —— 契约**从 CSS 推导**，不维护第二份清单。
 *     （`next/font` 要求字面量，传变量直接构建失败，故 app 侧无法 import 契约，只能靠守卫兜住。）
 *
 * 用法：`pnpm check:ui`（非零退出码表示存在违例）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** UI 包根目录（相对 cwd）—— 组件库 + 设计系统（token / 字体契约）都在这里 */
const UI_ROOT = 'packages/ui'
/** 前端应用扫描根目录（相对 cwd） */
const APPS_ROOT = 'apps'
/** 脚手架模板根目录（相对 cwd） */
const TEMPLATES_ROOT = 'scripts/cli/templates/files'

export interface UiViolation {
  /**
   * 'export'   = 自有组件未导出
   * 'script'   = 前端包缺 typecheck 脚本
   * 'palette'  = 新增硬编码业务调色板类（应走设计系统语义 token）
   * 'template' = 脚手架模板的样式入口无法解析
   * 'font'     = next/font 变量名与设计系统契约不一致
   */
  kind: 'export' | 'script' | 'palette' | 'template' | 'font'
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

/** 递归收集目录下匹配扩展名的文件（目录不存在返回空数组） */
function collectFiles(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return collectFiles(full, pattern)
    return pattern.test(entry.name) ? [full] : []
  })
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

/** B. 前端包（apps/ 与 @repo/ui）是否都声明了 typecheck 脚本 */
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

/** 业务调色板类（`bg-blue-500` / `text-zinc-400` / `border-indigo-200` …） */
const PALETTE_PATTERN =
  /(?:^|[^a-zA-Z0-9-])(?:bg|text|border|ring|from|via|to|fill|stroke|decoration|outline|divide|shadow|placeholder|caret|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/g

/**
 * 存量基线：文件 → 允许出现的硬编码调色板类**上限**（2026-09-17 实测）。
 *
 * 只许减少不许增加，故存量收敛后**无需**维护这张表（上限仍宽松）；想收紧时手动下调。
 * 不在表内的文件 = 上限 0（新增文件一律不得硬编码）。
 */
const PALETTE_BASELINE: Record<string, number> = {
  // apps/admin 存量
  'apps/admin/src/app/auth/layout.tsx': 13,
  'apps/admin/src/app/main/dashboard/page.tsx': 5,
  'apps/admin/src/app/main/monitor/live/page.tsx': 4,
  'apps/admin/src/app/main/todo/page.tsx': 1,
  'apps/admin/src/components/AppSider.tsx': 3,
  // apps/web 存量（前台落地页为主，待独立一轮收敛到语义 token）
  'apps/web/src/app/account/layout.tsx': 5,
  'apps/web/src/app/account/nav.tsx': 5,
  'apps/web/src/app/account/page.tsx': 6,
  'apps/web/src/app/account/sessions/page.tsx': 11,
  'apps/web/src/app/auth/forgot-password/page.tsx': 4,
  'apps/web/src/app/auth/layout.tsx': 9,
  'apps/web/src/app/auth/login/page.tsx': 4,
  'apps/web/src/app/auth/register/page.tsx': 4,
  'apps/web/src/app/auth/reset-password/page.tsx': 4,
  'apps/web/src/app/comparison/page.tsx': 42,
  'apps/web/src/app/error.tsx': 3,
  'apps/web/src/app/markdown/layout.tsx': 2,
  'apps/web/src/app/markdown/nav.tsx': 7,
  'apps/web/src/app/markdown/page.tsx': 6,
  'apps/web/src/app/not-found.tsx': 2,
  'apps/web/src/app/page.tsx': 2,
  'apps/web/src/components/landing/ai-section.tsx': 48,
  'apps/web/src/components/landing/architecture.tsx': 15,
  'apps/web/src/components/landing/choice.tsx': 22,
  'apps/web/src/components/landing/cta-section.tsx': 9,
  'apps/web/src/components/landing/features.tsx': 57,
  'apps/web/src/components/landing/footer.tsx': 15,
  'apps/web/src/components/landing/header.tsx': 42,
  'apps/web/src/components/landing/hero.tsx': 20,
  'apps/web/src/components/landing/quick-start.tsx': 50,
  'apps/web/src/components/landing/tech-marquee.tsx': 3,
  'apps/web/src/components/landing/why.tsx': 11,
  // packages/ui 存量（tag.tsx 的 antd 装饰色名，待独立一轮收敛）
  'packages/ui/src/components/display.tsx': 1,
  'packages/ui/src/components/tag.tsx': 30,
}

/** C. 是否新增了硬编码业务调色板类（超过基线即违例） */
export function scanHardcodedPalette(cwd = process.cwd()): UiViolation[] {
  const violations: UiViolation[] = []
  const roots = [
    join(cwd, UI_ROOT, 'src'),
    ...(existsSync(join(cwd, APPS_ROOT))
      ? readdirSync(join(cwd, APPS_ROOT))
          .filter((entry) => statSync(join(cwd, APPS_ROOT, entry)).isDirectory())
          .map((entry) => join(cwd, APPS_ROOT, entry, 'src'))
      : []),
  ]

  for (const root of roots) {
    for (const file of collectFiles(root, /\.(ts|tsx)$/)) {
      const target = relative(cwd, file)
      const hits = [...readFileSync(file, 'utf8').matchAll(PALETTE_PATTERN)].length
      const limit = PALETTE_BASELINE[target] ?? 0
      if (hits > limit) {
        violations.push({
          kind: 'palette',
          target,
          detail:
            `新增硬编码调色板类 ${hits - limit} 处（现有 ${hits}，上限 ${limit}）—— ` +
            '请改用设计系统语义 token（bg-primary / text-muted-foreground / text-success …）',
        })
      }
    }
  }

  return violations
}

/** 模板中的工作区包样式入口：`@import "@repo/<pkg>/<路径>.css"` */
const TEMPLATE_CSS_IMPORT = /@import\s+"(@repo\/[^"]+\.css)"/g

/** D. 工作区包的样式入口（app / @repo/ui / CLI 模板里的 `@import "@repo/..."`）是否指向真实存在的文件 */
export function scanStyleEntries(cwd = process.cwd()): UiViolation[] {
  const violations: UiViolation[] = []

  const roots = [
    join(cwd, TEMPLATES_ROOT),
    ...(existsSync(join(cwd, APPS_ROOT))
      ? readdirSync(join(cwd, APPS_ROOT))
          .filter((entry) => statSync(join(cwd, APPS_ROOT, entry)).isDirectory())
          .map((entry) => join(cwd, APPS_ROOT, entry, 'src'))
      : []),
    join(cwd, UI_ROOT, 'src'),
  ]

  for (const file of roots.flatMap((root) => collectFiles(root, /\.(css|eta)$/))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(TEMPLATE_CSS_IMPORT)) {
      const specifier = match[1] as string
      const parsed = specifier.match(/^@repo\/([^/]+)\/(.+)$/)
      if (!parsed) continue
      const [, pkg, rest] = parsed
      const resolved = join(cwd, 'packages', pkg as string, 'src', rest as string)
      if (!existsSync(resolved)) {
        violations.push({
          kind: 'template',
          target: relative(cwd, file),
          detail:
            `样式入口 ${specifier} 无法解析（应存在 packages/${pkg}/src/${rest}）—— ` +
            '工作区包的导出改名后请同步所有引用处（app / @repo/ui / 脚手架模板）',
        })
      }
    }
  }

  return violations
}

/** E. next/font 变量名是否与设计系统契约一致（契约从 globals.css 推导，不维护第二份清单） */
export function scanFontContract(cwd = process.cwd()): UiViolation[] {
  const violations: UiViolation[] = []

  const cssPath = join(cwd, UI_ROOT, 'src/globals.css')
  if (!existsSync(cssPath)) return []
  // 只取「应用需注入」的三个变量：--font-heading 是从 --font-display 派生的别名，不算
  const expected = [
    ...readFileSync(cssPath, 'utf8').matchAll(
      /--font-(?:sans|mono|display)\s*:\s*var\((--[a-z0-9-]+)\)/g,
    ),
  ].map((match) => match[1] as string)
  if (expected.length === 0) return []

  const targets: string[] = []
  const appsDir = join(cwd, APPS_ROOT)
  if (existsSync(appsDir)) {
    for (const entry of readdirSync(appsDir)) {
      if (!statSync(join(appsDir, entry)).isDirectory()) continue
      targets.push(join(appsDir, entry, 'src/app/layout.tsx'))
    }
  }
  targets.push(join(cwd, TEMPLATES_ROOT, 'client/layout.eta'))

  for (const target of targets) {
    if (!existsSync(target)) continue
    const source = readFileSync(target, 'utf8')
    const missing = expected.filter(
      (name) => !source.includes(`'${name}'`) && !source.includes(`"${name}"`),
    )
    if (missing.length > 0) {
      violations.push({
        kind: 'font',
        target: relative(cwd, target),
        detail:
          `next/font 变量名与 ${UI_ROOT}/src/globals.css 的字体契约不一致，缺少字面量：` +
          `${missing.join(' / ')}（next/font 要求字面量，无法 import 常量）`,
      })
    }
  }

  return violations
}

/** 汇总全部前端约定违例 */
export function scanFrontendConventions(cwd = process.cwd()): UiViolation[] {
  return [
    ...scanOwnComponentExports(cwd),
    ...scanFrontendPackages(cwd),
    ...scanHardcodedPalette(cwd),
    ...scanStyleEntries(cwd),
    ...scanFontContract(cwd),
  ]
}

/** CLI 入口：非零退出码表示存在违例 */
function main(): void {
  const violations = scanFrontendConventions()
  if (violations.length === 0) {
    console.log(
      '[check:ui] ✅ 组件导出完整 / 前端包质量脚本齐备 / 无新增硬编码调色板 / 模板样式入口可解析 / 字体契约一致',
    )
    return
  }
  console.error(`[check:ui] ❌ 发现 ${violations.length} 处违例：`)
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.target}  ${v.detail}`)
  }
  console.error(
    '\n提示：组件必须从 packages/ui/src/index.ts 导出；前端包必须声明 typecheck 脚本；' +
      '视觉取值走设计系统语义 token；改动工作区包导出后同步 scripts/cli/templates；' +
      '字体变量名与 packages/ui/src/globals.css 的回退链保持一致（见 docs/design/design-system.md）。',
  )
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
