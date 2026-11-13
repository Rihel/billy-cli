/**
 * DI 装饰器一致性守卫（工程规范第 6 条的可执行版本）。
 *
 * 背景：开发态用 tsx（esbuild）**不产出 `design:paramtypes`**，Nest 拿不到构造器参数类型，
 * 因此由容器装配的类，**每个构造器参数都必须显式 `@Inject(token)`**，
 * 漏写会**静默注入 `undefined`**（不报错，运行时才炸）。
 *
 * 本脚本检查两条不变量：
 *  A. 标了 `@Injectable()` / `@Controller()` / `@Catch()` 的类，构造器每个参数必须含 `@Inject(`；
 *  B. 出现在 `providers:` 数组里的裸类名，必须标了 `@Injectable()`（否则同样拿不到 token）。
 *
 * 反过来也统一：**不经过容器装配的类**（手工 `new`、`useFactory: () => new X()`、
 * 由第三方实例化）刻意**不写** DI 装饰器——写了是死代码且误导（如 `RedisListCache` / `Telemetry`）。
 *
 * 用法：`pnpm check:inject`（同时被 `apps/server` 的单测覆盖，见 test/di-inject-convention.test.ts）。
 */
import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 默认扫描范围（仓库根为基准） */
export const DEFAULT_ROOTS = ['packages/kits/src', 'apps/server/src']

export interface InjectViolation {
  file: string
  line: number
  /** 'param' = 容器装配的类缺 @Inject；'provider' = providers 里的类缺 @Injectable */
  kind: 'param' | 'provider'
  detail: string
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** 从 `constructor(` 起用括号配平取出参数文本 */
function extractConstructors(src: string): { start: number; params: string }[] {
  const out: { start: number; params: string }[] = []
  let i = 0
  while ((i = src.indexOf('constructor(', i)) !== -1) {
    const lineStart = src.lastIndexOf('\n', i) + 1
    const line = src.slice(lineStart, i)
    if (line.includes('//') || line.trim().startsWith('*')) {
      i += 'constructor('.length
      continue
    }
    let j = i + 'constructor('.length
    let depth = 1
    let inStr: string | null = null
    while (j < src.length && depth > 0) {
      const ch = src[j]
      if (inStr) {
        if (ch === '\\') {
          j += 2
          continue
        }
        if (ch === inStr) inStr = null
      } else if (ch === "'" || ch === '"' || ch === '`') inStr = ch
      else if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') depth--
      j++
    }
    out.push({ start: i, params: src.slice(i + 'constructor('.length, j - 1) })
    i = j
  }
  return out
}

/** 按顶层逗号切分参数 */
function splitParams(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let inStr: string | null = null
  let cur = ''
  for (let k = 0; k < text.length; k++) {
    const ch = text[k]
    if (inStr) {
      cur += ch
      if (ch === '\\') {
        cur += text[++k]
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch
      cur += ch
      continue
    }
    if ('([{<'.includes(ch)) depth++
    if (')]}>'.includes(ch)) depth--
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) parts.push(cur)
  return parts.map((p) => p.trim()).filter(Boolean)
}

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length

/**
 * 判断构造函数所属的类是否由容器装配。
 *
 * **只看紧邻 `class` 的装饰器行**，不做大范围文本匹配——否则注释里提到的
 * `` `@Injectable()` ``（本文件帮大家解释约定时就会写）会被误判为真装饰器。
 */
function isContainerManaged(src: string, ctorStart: number): boolean {
  const classIdx = src.lastIndexOf('class ', ctorStart)
  if (classIdx === -1) return false

  // 注意切到「class 所在行的行首」：`class` 出现在行中间（`export class X`），
  // 直接按 classIdx 切会把 `  export ` 这半行当成上一行，导致循环第一轮就 break。
  const classLineStart = src.lastIndexOf('\n', classIdx) + 1
  const before = src.slice(0, classLineStart).split('\n')
  // 从类声明上一行往上连续收集装饰器行（单行装饰器；工程内无多行装饰器写法）
  const decorators: string[] = []
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i].trim()
    if (line === '') continue
    if (line.startsWith('@')) {
      decorators.unshift(line)
      continue
    }
    break
  }
  return decorators.some((d) => /^@(Injectable|Controller|Catch)\b/.test(d))
}

/** 提取 providers 数组里的裸类名（跳过 `{ provide: ... }`、展开等表达式） */
function extractProviderClassNames(src: string): string[] {
  const names: string[] = []
  const re = /providers:\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let j = m.index + m[0].length
    let depth = 1
    const start = j
    while (j < src.length && depth > 0) {
      const ch = src[j]
      if (ch === '[' || ch === '{' || ch === '(') depth++
      else if (ch === ']' || ch === '}' || ch === ')') depth--
      j++
    }
    const body = src.slice(start, j - 1)
    for (const raw of splitParams(body)) {
      const entry = raw.trim()
      if (!entry || entry.includes('{') || entry.startsWith('...')) continue
      if (/^[A-Z][A-Za-z0-9_]*$/.test(entry)) names.push(entry)
    }
  }
  return names
}

/** 扫描给定根目录，返回全部违例 */
export function scanInjectDecorators(
  roots: string[] = DEFAULT_ROOTS,
  cwd = process.cwd(),
): InjectViolation[] {
  const files = roots.flatMap((root) => {
    const abs = join(cwd, root)
    try {
      return walk(abs)
    } catch {
      return []
    }
  })

  const violations: InjectViolation[] = []
  /** 类名 → 是否带 DI 装饰器（用于不变量 B） */
  const classHasDi = new Map<string, boolean>()
  const providerRefs: { file: string; line: number; name: string }[] = []

  for (const file of files) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(cwd, file)

    // 记录类声明与其 DI 装饰器状态
    for (const cm of src.matchAll(
      /(?:^|\n)((?:@[A-Za-z]+\([^)]*\)\s*)*)export\s+class\s+([A-Za-z0-9_]+)/g,
    )) {
      classHasDi.set(cm[2], /@(Injectable|Controller|Catch)\(/.test(cm[1]))
    }

    // 不变量 A
    for (const ctor of extractConstructors(src)) {
      if (!isContainerManaged(src, ctor.start)) continue
      for (const param of splitParams(ctor.params)) {
        if (param.startsWith('//') || param.startsWith('*') || param.startsWith('/*')) continue
        if (!param.includes('@Inject(')) {
          violations.push({
            file: rel,
            line: lineOf(src, ctor.start),
            kind: 'param',
            detail: param.replace(/\s+/g, ' ').slice(0, 100),
          })
        }
      }
    }

    // 收集 providers 里的裸类名
    if (file.includes('.module.ts')) {
      for (const name of extractProviderClassNames(src)) {
        providerRefs.push({ file: rel, line: lineOf(src, src.indexOf(name)), name })
      }
    }
  }

  // 不变量 B
  for (const ref of providerRefs) {
    if (classHasDi.get(ref.name) === false) {
      violations.push({
        file: ref.file,
        line: ref.line,
        kind: 'provider',
        detail: `providers 里的 ${ref.name} 缺 @Injectable()`,
      })
    }
  }

  return violations
}

/** CLI 入口：非零退出码表示存在违例 */
function main(): void {
  const violations = scanInjectDecorators()
  if (violations.length === 0) {
    console.log('[check:inject] ✅ 构造器 @Inject / providers @Injectable 一致，无违例')
    return
  }
  console.error(`[check:inject] ❌ 发现 ${violations.length} 处违例：`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.kind}] ${v.detail}`)
  }
  console.error(
    '\n提示：由容器装配的类，每个构造器参数都要写 @Inject(token)（tsx 不产出 design:paramtypes，漏写静默注入 undefined）。',
  )
  process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
