#!/usr/bin/env node
/**
 * 把 `src/` 下的 HTML 片段合并成**可直接预览的单文件 HTML**。
 *
 * 用法（在会话工作区根目录跑）：
 *   node scripts/build-html.mjs
 *   node scripts/build-html.mjs --entry src/index.html --out dist/index.html
 *
 * 只做三件事，不做打包器：
 *   1. 展开 `<!-- include: sections/x.html -->`（路径相对**当前文件**）；
 *   2. 内联 `./x.css` / `./x.js`（路径相对**entry 所在目录**）；
 *   3. 校验产物（相对引用残留、片段混进 <head>、体积超过预览上限等）。
 *
 * 出参：stdout 打一份 JSON 报告，`ok:false` 时退出码 1（errors 会一次列全，照着修就行）。
 * 无第三方依赖、不联网、不执行页面脚本。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

const ROOT = process.cwd()
/** 预览只读文本前 1MB，超过会被截断，所以产物直接卡在这个值 */
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_INCLUDES = 200
const MAX_DEPTH = 8
const MAX_REPORT_ITEMS = 20
const CDN_HOSTS = ['registry.npmmirror.com', 'cdn.jsdelivr.net', 'unpkg.com']

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const entry = resolve(ROOT, argOf('entry', 'src/index.html'))
const out = resolve(ROOT, argOf('out', 'dist/index.html'))
const entryDir = dirname(entry)

const errors = []
const warnings = []
const files = []
const seenFiles = new Set()
/** 已展开的片段数（含 entry） */
let expanded = 0

const rel = (path) => relative(ROOT, path).split(sep).join('/')
const inside = (path) => path === ROOT || path.startsWith(ROOT + sep)
const lineOf = (text, index) => text.slice(0, index).split('\n').length
const addError = (code, message, file, from) => {
  errors.push({ code, message, ...(file ? { file } : {}), ...(from ? { from } : {}) })
}
const addWarning = (code, message, file) => {
  warnings.push({ code, message, ...(file ? { file } : {}) })
}

/** 读文本并记账（同一文件只记一次字节数） */
const readText = (file) => {
  const text = readFileSync(file, 'utf8')
  if (!seenFiles.has(file)) {
    seenFiles.add(file)
    files.push({ path: rel(file), bytes: Buffer.byteLength(text, 'utf8') })
  }
  return text
}

/** 外链（含协议相对 //host） */
const isExternal = (url) => /^(?:https?:)?\/\//i.test(url)
/** 相对引用：非外链、非锚点、非 data:/mailto:/blob: 这类协议 */
const isRelative = (url) =>
  Boolean(url) && !isExternal(url) && !url.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(url)

/** CDN 白名单检查：能在沙箱里加载的只有这三家；其余写了也是静默空白，所以给 warning */
const checkExternal = (url, file) => {
  if (!url.startsWith('https://')) {
    addWarning('insecure-external', `外链必须是 https：${url}`, file)
    return
  }
  const host = url.slice('https://'.length).split(/[/?#]/)[0]
  if (!CDN_HOSTS.includes(host)) {
    addWarning(
      'external-host',
      `沙箱只放行 ${CDN_HOSTS.join(' / ')}，这个地址加载不出来：${host}`,
      file,
    )
  }
}

// ── 1. 展开 include ─────────────────────────────────────────────────────────

const INCLUDE = /<!--\s*include:\s*([^\s]+?)\s*-->/g

const expand = (file, stack, from) => {
  if (!inside(file)) {
    addError('path-escape', `include 路径越出工作区：${rel(file)}`, undefined, from)
    return ''
  }
  if (stack.includes(file)) {
    addError(
      'include-cycle',
      `循环 include：${[...stack, file].map(rel).join(' → ')}`,
      undefined,
      from,
    )
    return ''
  }
  if (stack.length > MAX_DEPTH) {
    addError('include-depth', `include 嵌套超过 ${MAX_DEPTH} 层：${rel(file)}`, undefined, from)
    return ''
  }
  if (!existsSync(file)) {
    addError('missing-include', `找不到片段：${rel(file)}`, undefined, from)
    return ''
  }
  if (expanded >= MAX_INCLUDES) {
    addError('include-count', `include 片段超过 ${MAX_INCLUDES} 个`, undefined, from)
    return ''
  }
  expanded += 1
  const text = readText(file)

  // 片段只写片段：<head> / Tailwind / 第三方库都只在骨架里出现
  if (file !== entry && /<(!doctype\b|html\b|head\b|body\b)/i.test(text)) {
    addError(
      'partial-has-document',
      '片段里不要写 <!doctype> / <html> / <head> / <body>（骨架才写）',
      rel(file),
      from,
    )
  }

  return text.replace(INCLUDE, (_match, target, offset) => {
    const next = resolve(dirname(file), target)
    const at = `${rel(file)}:${lineOf(text, offset)}`
    return expand(next, [...stack, file], at)
  })
}

// ── 2. 内联本地 css / js ────────────────────────────────────────────────────

const LINK_TAG = /<link\b[^>]*>/gi
const SCRIPT_TAG = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi

const inlineAsset = (url, kind, tag) => {
  if (isExternal(url)) {
    checkExternal(url, rel(entry))
    return tag
  }
  if (!isRelative(url)) return tag
  const file = resolve(entryDir, url)
  if (!inside(file)) {
    addError('path-escape', `资源路径越出工作区：${url}`)
    return tag
  }
  if (!existsSync(file)) {
    addError('missing-asset', `找不到 ${url}（相对路径按 ${rel(entryDir)}/ 解析）`)
    return tag
  }
  const body = readText(file)
  if (kind === 'css') {
    return `<style>\n${body.replace(/<\/style/gi, '<\\/style')}\n</style>`
  }
  const isModule = /type\s*=\s*["']module["']/i.test(tag)
  if (isModule) {
    addWarning(
      'module-script',
      '内联的 module 脚本里不要用 import 裸包名（沙箱解析不了）',
      rel(file),
    )
  }
  return `<script${isModule ? ' type="module"' : ''}>\n${body.replace(/<\/script/gi, '<\\/script')}\n</script>`
}

const inlineAssets = (html) =>
  html
    .replace(LINK_TAG, (tag) => {
      const relAttr = /rel\s*=\s*["']([^"']+)["']/i.exec(tag)
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)
      if (!relAttr || !href || !/stylesheet/i.test(relAttr[1])) return tag
      return inlineAsset(href[1], 'css', tag)
    })
    .replace(SCRIPT_TAG, (tag, src) => inlineAsset(src, 'js', tag))

// ── 3. 校验产物 ─────────────────────────────────────────────────────────────

/**
 * 只校验「标记 + 样式」：`<script>` 体内是 JS，字符串里出现 `url(%23n)`、`src="./x"`
 * 是代码内容、不是资源引用（真实页面里内联 SVG 常这么写），扫进去会误报。
 * 保留 `<script src="...">` 的**开标签**，真正的相对脚本引用仍然抓得到。
 */
const markupOf = (html) => html.replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, '$1$2')

const checkLeftovers = (html) => {
  const markup = markupOf(html)
  const attr = /\b(src|href)\s*=\s*["']([^"']*)["']/gi
  let match
  while ((match = attr.exec(markup)) !== null) {
    const [, name, url] = match
    if (!isRelative(url)) continue
    const isResource =
      name === 'src' || /\.(css|js|mjs|png|jpe?g|gif|webp|svg|woff2?|ttf|ico)$/i.test(url)
    if (isResource) {
      addError(
        'leftover-relative',
        `产物里还有相对引用 ${url}：预览里没有第二份文件，请改 CDN 或内联`,
      )
    } else {
      addWarning('dead-link', `相对链接在预览里打不开：${url}`)
    }
  }
  const cssUrl = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi
  while ((match = cssUrl.exec(markup)) !== null) {
    const url = match[1]
    // `%23n` 是 URL 编码的 `#n`（SVG 滤镜 / 渐变常这么写），不是相对路径
    if (url.toLowerCase().startsWith('%23')) continue
    if (!isRelative(url)) continue
    addError('leftover-relative', `样式里还有相对 url(${url})：图片请用 CDN 或 data: URI`)
  }
}

const main = () => {
  if (!inside(entry) || !inside(out)) {
    addError('path-escape', 'entry / out 必须在工作区内')
    return ''
  }
  if (!existsSync(entry)) {
    addError('missing-entry', `找不到入口文件 ${rel(entry)}（默认 src/index.html）`)
    return ''
  }

  const merged = inlineAssets(expand(entry, [], undefined))
  checkLeftovers(merged)

  if (!/<!doctype\s+html/i.test(merged)) {
    addWarning('no-doctype', '缺少 <!doctype html>，部分样式会退回怪异模式')
  }
  if (!merged.includes('@tailwindcss/browser')) {
    addWarning('no-tailwind', '没有引 @tailwindcss/browser：页面样式不符合交付口径')
  }

  const bytes = Buffer.byteLength(merged, 'utf8')
  if (bytes > MAX_OUTPUT_BYTES) {
    addError(
      'too-large',
      `产物 ${(bytes / 1024).toFixed(0)}KB，超过预览上限 ${MAX_OUTPUT_BYTES / 1024}KB（大表先聚合 / 抽样）`,
    )
  }
  return merged
}

const output = main()

if (errors.length === 0) {
  mkdirSync(dirname(out), { recursive: true })
  const temp = `${out}.tmp`
  writeFileSync(temp, output)
  renameSync(temp, out)
}

const report = {
  ok: errors.length === 0,
  entry: rel(entry),
  out: rel(out),
  bytes: errors.length === 0 ? Buffer.byteLength(output, 'utf8') : 0,
  files,
  errors: errors.slice(0, MAX_REPORT_ITEMS),
  warnings: warnings.slice(0, MAX_REPORT_ITEMS),
}
if (errors.length > MAX_REPORT_ITEMS) report.errorsTruncated = errors.length - MAX_REPORT_ITEMS
if (warnings.length > MAX_REPORT_ITEMS)
  report.warningsTruncated = warnings.length - MAX_REPORT_ITEMS

console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1
