import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { SkillLoader } from '../src/modules/ai/core/skills/skill.loader.js'

/**
 * `html-page` 自带的构建脚本（`scripts/build-html.mjs`）的**真实执行**守卫。
 *
 * 为什么要跑一遍：这段脚本是「模型拆片段 → 合并成单文件」的唯一确定性环节，
 * 它烂掉的表现不是报错，而是产物缺内容 / 相对路径落空 / 页面一片空白。
 * 所以这里用临时工作区真跑，钉住四条：include 展开、css/js 内联与转义、
 * 片段混进 `<head>` 被拦、以及错误时不写产物。
 */

const logger = {
  log: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as never

/** 取内置技能目录下的构建脚本（顺带验证它确实在技能目录里） */
const buildScript = async (): Promise<string> => {
  const ref = (await new SkillLoader(logger).resolve(['html-page']))[0]
  if (!ref) throw new Error('内置技能不存在：html-page')
  const file = join(ref.path, 'scripts', 'build-html.mjs')
  expect(existsSync(file)).toBe(true)
  return file
}

const makeWorkspace = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'html-build-'))
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return root
}

interface BuildReport {
  ok: boolean
  bytes: number
  files: { path: string; bytes: number }[]
  errors: { code: string; message: string }[]
  warnings: { code: string }[]
}

const run = (script: string, cwd: string) => {
  const result = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' })
  let report: BuildReport | null = null
  try {
    report = JSON.parse(result.stdout) as BuildReport
  } catch {
    report = null
  }
  return { status: result.status, stderr: result.stderr, report }
}

const FRAME = (body: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<script src="https://registry.npmmirror.com/@tailwindcss/browser/4.3.5/files/dist/index.global.js"></script>
<link rel="stylesheet" href="./styles/app.css">
</head><body>
${body}
<script src="./scripts/app.js"></script>
</body></html>
`

describe('html-page 构建脚本', () => {
  it('展开 include、内联 css / js，并把 </script> 转义后写出单文件', async () => {
    const script = await buildScript()
    const cwd = makeWorkspace({
      'src/index.html': FRAME(
        '<!-- include: sections/hero.html -->\n<!-- include: sections/data.html -->',
      ),
      'src/sections/hero.html': '<section class="text-xl">Hero</section>',
      'src/sections/data.html': '<table><tr><td>42</td></tr></table>',
      'src/styles/app.css': '.hero { color: red }',
      'src/scripts/app.js': 'document.write("<script src=a></script>")',
    })

    const { status, report } = run(script, cwd)
    expect(status).toBe(0)
    expect(report?.ok).toBe(true)
    // 片段确实被展开，而不是留在产物里当注释
    expect(report?.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['src/sections/hero.html', 'src/sections/data.html']),
    )

    const html = readFileSync(join(cwd, 'dist/index.html'), 'utf8')
    expect(html).toContain('Hero')
    expect(html).toContain('42')
    expect(html).toContain('<style>')
    expect(html).toContain('.hero { color: red }')
    // 内联的 JS 不能把 <script> 提前闭合
    expect(html).toContain('<\\/script>')
    expect(html).not.toContain('<!-- include:')
    expect(html).not.toContain('href="./styles/app.css"')
    // 产物是一份**完整文档**（不是片段拼接的中间态）
    expect(html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
    expect(html.match(/<html\b/gi)).toHaveLength(1)
  })

  it('脚本体内出现 url(%23n) / 相对 src 字符串不算资源引用', async () => {
    const script = await buildScript()
    const cwd = makeWorkspace({
      'src/index.html': FRAME(`<section id="s"></section>
<script>
  var svg = "<svg><filter id='n'></filter><rect filter='url(%23n)'/></svg>"
  var tpl = '<script src="./x.js"><\\/script>'
  document.getElementById('s').insertAdjacentHTML('beforeend', svg)
  console.log(tpl)
</script>`),
      'src/styles/app.css': '',
      'src/scripts/app.js': '',
    })

    // 真实页面（内联 SVG 滤镜 / 拼接 <script> 字符串）常这么写，扫进 JS 会误报成"相对引用"
    const { status, report } = run(script, cwd)
    expect(report?.ok).toBe(true)
    expect(status).toBe(0)
    expect((report?.errors ?? []).map((error) => error.code)).not.toContain('leftover-relative')
  })

  it('Tailwind 浮动版本 + 只引一家 CDN 时给 warning，但不阻断构建', async () => {
    const script = await buildScript()
    const cwd = makeWorkspace({
      'src/index.html': `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head><body><section>hi</section></body></html>`,
    })

    const { status, report } = run(script, cwd)
    expect(report?.ok).toBe(true)
    expect(status).toBe(0)
    const codes = (report?.warnings ?? []).map((warning) => warning.code)
    // 浮动版本会让 CDN 发新版时悄悄换样式；只引一家断了就丢栅格 —— 两条都要在报告里说出来
    expect(codes).toContain('tailwind-unpinned')
    expect(codes).toContain('single-cdn')
  })

  it('版本写死 + 三级兜底时不报这两条 warning', async () => {
    const script = await buildScript()
    const cwd = makeWorkspace({
      'src/index.html': `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<script src="https://registry.npmmirror.com/@tailwindcss/browser/4.3.5/files/dist/index.global.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.5/dist/index.global.js"></script>
<script src="https://unpkg.com/@tailwindcss/browser@4.3.5/dist/index.global.js"></script>
</head><body><section>hi</section></body></html>`,
    })

    const { report } = run(script, cwd)
    expect(report?.ok).toBe(true)
    const codes = (report?.warnings ?? []).map((warning) => warning.code)
    expect(codes).not.toContain('tailwind-unpinned')
    expect(codes).not.toContain('single-cdn')
  })

  it('片段里写 <head>、include 缺失、相对图片引用都会拦下，且不写产物', async () => {
    const script = await buildScript()
    const cwd = makeWorkspace({
      'src/index.html': FRAME(
        '<!-- include: sections/missing.html -->\n<!-- include: sections/bad.html -->\n<img src="./logo.png">',
      ),
      'src/sections/bad.html': '<head><title>片段不该有 head</title></head>',
      'src/styles/app.css': '',
      'src/scripts/app.js': '',
    })

    const { status, report } = run(script, cwd)
    expect(status).toBe(1)
    expect(report?.ok).toBe(false)
    const codes = (report?.errors ?? []).map((error) => error.code)
    expect(codes).toEqual(expect.arrayContaining(['missing-include', 'partial-has-document']))
    // 相对图片在预览里必然落空
    expect(codes).toContain('leftover-relative')
    expect(existsSync(join(cwd, 'dist/index.html'))).toBe(false)
  })
})
