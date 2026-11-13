import TurndownService from 'turndown'

/**
 * **HTML → Markdown**（`web-fetch` 的唯一转换处）。
 *
 * 为什么不再自己写一套正则清洗：
 * - 模型要的是"能读的正文"，HTML 里 `<div>` 套 `<div>` 的排版信息对它是纯噪音。
 *   Markdown 保留了标题层级 / 列表 / 表格 / 代码块这些**结构性**信息，字符还少一半；
 * - 自己写正则删标签，一定会漏（注释、属性里的引号、`<script>` 里的字符串都被当标签处理过）。
 *
 * 三处刻意的定制（默认行为都不够用）：
 * 1. **表格**：Turndown 默认把表格拍平成文字，一行一格，完全看不出行列关系。
 *    这里补一条规则转成 GFM 表格 —— 文档站 / 维基 / 参数表全靠它；
 * 2. **删掉噪声节点**：`script` / `style` / `svg` / `iframe` 的内容留在 md 里纯属占行数
 *    （页是按行切的，噪音直接等于浪费页数）；
 * 3. **压缩空行**：HTML 转出来的 md 常常一行内容夹三个空行。压到最多一个空行，
 *    代码块内部原样保留（否则缩进敏感的语言会被压坏）。
 */

/** Turndown 单例：它没有状态，但每次 new 都要重建一遍规则表，没必要 */
let service: TurndownService | null = null

/** 单元格文本：压掉换行、转义竖线（否则会把表格切坏） */
const cellText = (cell: Element): string =>
  (cell.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()

/**
 * 表格 → GFM 表格。
 *
 * 口径：**第一行当表头**（有 `<thead>` / `<th>` 时本来就对；没有时也不会丢内容，
 * 只是第一行语义上变成表头）。列数取各行最大值，缺的补空格 —— 列数不齐的表格
 * 在 Markdown 里是渲染不出来的。
 */
const tableToMarkdown = (table: Element): string => {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (!rows.length) return ''
  const grid = rows.map((row) => Array.from(row.querySelectorAll('th,td')).map(cellText))
  const columns = Math.max(...grid.map((row) => row.length))
  if (!columns) return ''
  const padded = grid.map((row) => [...row, ...Array<string>(columns - row.length).fill('')])
  const [header, ...rest] = padded
  if (!header) return ''
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`
  const divider = line(Array<string>(columns).fill('---'))
  return [line(header), divider, ...rest.map(line)].join('\n')
}

const getService = (): TurndownService => {
  if (service) return service
  const svc = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  })
  // 噪声节点：内容留着只是占行（页是按行切的，导航条与侧栏直接等于浪费页数）
  // 只删 `nav` / `aside`，**不删 `header`** —— 文章标题常常就在 `<article><header><h1>` 里
  svc.remove([
    'script',
    'style',
    'noscript',
    'template',
    'canvas',
    'iframe',
    'form',
    'nav',
    'aside',
  ])
  // 语义化标签之外，还有一批用 role 表达的同类区块
  svc.addRule('drop-noise-role', {
    filter: (node) =>
      node.nodeType === 1 &&
      ['navigation', 'complementary', 'banner', 'search'].includes(
        (node as unknown as Element).getAttribute?.('role') ?? '',
      ),
    replacement: () => '',
  })
  svc.addRule('drop-svg', {
    filter: (node) => node.nodeName === 'svg' || node.nodeName === 'SVG',
    replacement: () => '',
  })
  // 表格：默认规则会把它拍平，这里接管
  svc.addRule('table', {
    filter: (node) => node.nodeName === 'TABLE',
    replacement: (_content, node) => `\n\n${tableToMarkdown(node as unknown as Element)}\n\n`,
  })
  service = svc
  return svc
}

/** 从完整 HTML 里只取 `<body>`：Turndown 吃整份文档会把 `<title>` / `<meta>` 当成正文吐出来 */
const bodyOf = (html: string): string => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)
  if (body?.[1]) return body[1]
  // 没有 body（片段 / 老页面）：至少把 head 去掉
  return html.replace(/<head[^>]*>[\s\S]*?<\/head>/i, '')
}

/** HTML 实体里最常见的几个（标题里出现 `&amp;` 很常见，解码一下更像人话） */
const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')

/** 取页面标题（给模型交代"这是哪个页面"，它引用时能说清来源） */
export const extractTitle = (html: string): string | null => {
  const raw = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  if (!raw) return null
  const title = decodeEntities(raw).replace(/\s+/g, ' ').trim()
  return title || null
}

/**
 * **压缩空行**：非代码块内最多一个空行，行尾空白去掉。
 *
 * 逐行扫而不是正则一把梭：代码块里的空行得原样留着，
 * `\n{3,}` 这种正则不知道自己在哪，会把 YAML / Python 的相对缩进压坏。
 */
const tidy = (markdown: string): string => {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let inFence = false
  let blank = 0
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      out.push(raw)
      blank = 0
      continue
    }
    if (inFence) {
      out.push(raw)
      continue
    }
    const line = raw.replace(/[ \t]+$/, '')
    if (line === '') {
      blank += 1
      if (blank > 1) continue
    } else {
      blank = 0
    }
    out.push(line)
  }
  return out.join('\n').trim()
}

/** 整份 HTML → Markdown（抛错由调用方兜：转不出来不是"抓取失败"，退回纯文本即可） */
export const htmlToMarkdown = (html: string): string => tidy(getService().turndown(bodyOf(html)))

/** 兜底：Turndown 出问题时，至少给一份去标签的纯文本（比整个工具失败有用） */
export const htmlToPlainText = (html: string): string =>
  tidy(
    decodeEntities(
      bodyOf(html)
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    ).replace(/[ \t]{2,}/g, ' '),
  )

/** 是不是 HTML（按 content-type 与正文特征判；有些站点 content-type 压根不给） */
export const looksLikeHtml = (contentType: string, text: string): boolean => {
  if (/html/i.test(contentType)) return true
  if (contentType && !/text\/plain|xml|json/i.test(contentType)) return false
  const head = text.slice(0, 1024).toLowerCase()
  return head.includes('<!doctype html') || /<html[\s>]/.test(head)
}

// ─────────────────────────── 反爬 / 人机验证识别 ───────────────────────────

/**
 * 已知的人机验证 / 反爬拦截页特征（命中即给出**人能读懂的拦截方**）。
 *
 * 拉一条宽带"安全验证"这种词也会出现在正常文章里，所以命中之后还要看分量（见下）。
 */
const BOT_MARKERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/百度安全验证/, '百度安全验证'],
  [/安全验证|人机验证|请完成验证|请输入验证码|滑动验证/, '人机验证页'],
  [
    /Just a moment|cf-browser-verification|Enable JavaScript and cookies to continue/i,
    'Cloudflare 验证',
  ],
  [/Attention Required|Access Denied|Access denied/, '访问被拒绝'],
  [
    /请开启JavaScript|请启用 ?JavaScript|enable JavaScript|Please enable JavaScript/i,
    '要求执行 JavaScript',
  ],
  [/verify (you are )?(a )?human|are you a robot|bot detection|anti.?bot/i, '人机验证页'],
]

/** 这些状态码是"我拒绝给你"，与"这个页面本来就没内容"是两件事 */
const REFUSED_STATUS = new Set([401, 403, 429, 503])

/** 短到这个长度的正文基本不可能是正常内容页（验证页都在这之下） */
const THIN_TEXT_CHARS = 500

/**
 * **是不是被反爬 / 人机验证拦住了**。
 *
 * 为什么必须单独判：403 的正文同样是"空的"，但它**不是**"页面没内容" ——
 * 说成"纯 JS 渲染"会让模型以为换种方式还能拿到，于是反复重试同一个地址；
 * 说成"被拦了"它才会去找别的来源（维基、官方文档、镜像站）。
 * 一句结论的差别，决定的是模型下一步做不做无用功。
 *
 * 只在"状态是拒绝类"或"正文几乎没有"时才认定：
 * 一篇长科普文里出现"验证码"三个字，不该被判成验证页。
 */
export const detectAntiBot = (input: {
  status: number
  title: string | null
  html: string
}): string | null => {
  const { status, title, html } = input
  const refused = REFUSED_STATUS.has(status)
  const hay = `${title ?? ''}\n${html.slice(0, 20_000)}`
  for (const [pattern, label] of BOT_MARKERS) {
    if (!pattern.test(hay)) continue
    if (refused || htmlToPlainText(html).length < THIN_TEXT_CHARS) return label
    return null
  }
  // 没有明显特征，但"拒绝类状态 + 正文极短"：正常页面不会这么短
  if (refused && htmlToPlainText(html).length < THIN_TEXT_CHARS) return `HTTP ${status}`
  return null
}
