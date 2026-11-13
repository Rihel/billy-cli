import { SANDBOX_CDN_HOSTS } from '@repo/shared/browser'

/**
 * 富内容围栏的纯逻辑：xflow 的解析与排版、沙箱文档与 CSP 的组装。
 *
 * 这里**不碰 React、不碰 DOM** —— 解析与排版出错时最难受的是"看起来渲染了但内容不对"，
 * 所以这一层做成纯函数，用单测把边界钉死（见 `packages/ui/test/markdown-fences.test.ts`）。
 */

/** 围栏语言标识。前端据此选渲染器，提示词里也用这几个词（见 requirements.eta）。 */
export const FENCE_LANGUAGES = {
  /** 流程图：JSON → React Flow */
  xflow: 'xflow',
  /** 页面预览：沙箱 iframe 直出 HTML */
  html: 'html',
  /** 动画：沙箱 iframe + 内置 gsap */
  gsap: 'gsap',
  /** 结构化数据：可折叠的树 */
  json: 'json',
} as const

// ── xflow ────────────────────────────────────────────────────────────────────

export type XflowNodeKind = 'start' | 'process' | 'decision' | 'end'

export interface XflowNode {
  id: string
  label: string
  description?: string
  kind: XflowNodeKind
}

export interface XflowEdge {
  from: string
  to: string
  label?: string
}

export interface XflowModel {
  title?: string
  direction: 'LR' | 'TB'
  nodes: XflowNode[]
  edges: XflowEdge[]
}

export type XflowParseResult = { ok: true; model: XflowModel } | { ok: false; error: string }

/** 节点上限：超过这个数，画布上已经看不出结构了，让调用方改成分组表达 */
const MAX_NODES = 60
const MAX_EDGES = 120

const NODE_KINDS: readonly XflowNodeKind[] = ['start', 'process', 'decision', 'end']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * 把围栏正文解析成流程图数据。
 *
 * 刻意**宽松取值、严格报错**：能容忍缺少 `direction` / `title` / `description`（模型不该为这些回退），
 * 但 id 重复、边指向不存在的节点、超过上限一律报错 —— 这几种错误静默纠正只会画出错的图。
 */
export const parseXflowSpec = (code: string): XflowParseResult => {
  let raw: unknown
  try {
    raw = JSON.parse(code)
  } catch {
    return { ok: false, error: '这段 xflow 不是合法 JSON，画不出图' }
  }
  if (!isRecord(raw)) {
    return { ok: false, error: 'xflow 的顶层必须是一个对象（title / direction / nodes / edges）' }
  }

  const rawNodes = raw.nodes
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) {
    return { ok: false, error: 'xflow 缺少 nodes：至少给一个节点' }
  }
  if (rawNodes.length > MAX_NODES) {
    return { ok: false, error: `xflow 节点太多（${rawNodes.length} 个），上限 ${MAX_NODES} 个` }
  }

  const nodes: XflowNode[] = []
  const seen = new Set<string>()
  for (const [index, item] of rawNodes.entries()) {
    if (!isRecord(item)) return { ok: false, error: `第 ${index + 1} 个节点不是对象` }
    const id = asText(item.id)
    const label = asText(item.label)
    if (!id) return { ok: false, error: `第 ${index + 1} 个节点缺少 id` }
    if (!label) return { ok: false, error: `节点 ${id} 缺少 label` }
    if (seen.has(id)) return { ok: false, error: `节点 id 重复：${id}` }
    seen.add(id)

    const kindText = asText(item.kind)
    const kind =
      kindText && (NODE_KINDS as readonly string[]).includes(kindText)
        ? (kindText as XflowNodeKind)
        : 'process'

    nodes.push({
      id,
      label,
      kind,
      ...(asText(item.description) ? { description: asText(item.description) as string } : {}),
    })
  }

  const rawEdges = raw.edges ?? []
  if (!Array.isArray(rawEdges)) return { ok: false, error: 'xflow 的 edges 必须是数组' }
  if (rawEdges.length > MAX_EDGES) {
    return { ok: false, error: `xflow 连线太多（${rawEdges.length} 条），上限 ${MAX_EDGES} 条` }
  }

  const edges: XflowEdge[] = []
  for (const [index, item] of rawEdges.entries()) {
    if (!isRecord(item)) return { ok: false, error: `第 ${index + 1} 条连线不是对象` }
    const from = asText(item.from)
    const to = asText(item.to)
    if (!from || !to) return { ok: false, error: `第 ${index + 1} 条连线缺少 from / to` }
    if (!seen.has(from)) return { ok: false, error: `连线指向不存在的节点：${from}` }
    if (!seen.has(to)) return { ok: false, error: `连线指向不存在的节点：${to}` }
    const label = asText(item.label)
    edges.push({ from, to, ...(label ? { label } : {}) })
  }

  const direction = raw.direction === 'TB' ? 'TB' : 'LR'
  const title = asText(raw.title)

  return {
    ok: true,
    model: { direction, nodes, edges, ...(title ? { title } : {}) },
  }
}

// ── 沙箱文档 ─────────────────────────────────────────────────────────────────

/** CSP host-source 的写法：协议 + 主机，不带路径（`https://registry.npmmirror.com`） */
const CDN_ORIGINS = SANDBOX_CDN_HOSTS.map((host) => `https://${host}`).join(' ')

/**
 * 沙箱 iframe 的内容安全策略。
 *
 * 底是 `default-src 'none'`：模型写的代码可以在框里跑（这是目的），但**连不出去** ——
 * `fetch` / XHR / WebSocket、表单提交、嵌套框架全禁，所以它没法把页面数据带到外部地址；
 * 父页面本身也不给它 `allow-same-origin`，拿不到 cookie 与后台页面的 DOM。
 *
 * 唯一的例外是 **CDN 白名单**（`SANDBOX_CDN_HOSTS`）：页面预览要能用第三方库（图表 / 动画 /
 * 表格 / 图标），只放行这几家的**脚本 / 样式 / 图片 / 字体 / 音视频**这几类子资源。
 * 口子开得很窄：能"用库画图"，不能"把数据发出去" —— `connect-src` 仍是 `'none'`，
 * 图片 / 字体也只能来自白名单主机或 `data:` / `blob:`，所以就算库代码有鬼，
 * 能让它带出去的地方也只有这几家 CDN。
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' ${CDN_ORIGINS}`,
  `style-src 'unsafe-inline' ${CDN_ORIGINS}`,
  `img-src data: blob: ${CDN_ORIGINS}`,
  `font-src data: ${CDN_ORIGINS}`,
  `media-src data: blob: ${CDN_ORIGINS}`,
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ')

/** 沙箱底色：跟随父页面当前主题，避免深色页面里蹦出一块白 */
export interface SandboxTheme {
  background: string
  color: string
}

export interface SandboxDocumentInput {
  /** 模型写的 HTML 片段（可以是完整文档，也可以只是一段） */
  html: string
  /**
   * 预置脚本（已由父页面取回的库，如内置 gsap），按顺序内联进 `<head>`。
   *
   * **必须在模型内容之前**：模型自己的 `<script>` 是在解析到那儿时立刻执行的，
   * 库放后面就等于"模型代码先跑、库还没定义"（`gsap is not defined`）。
   */
  scripts?: string[]
  theme: SandboxTheme
}

/** 防止脚本文本里出现 `</script>` 把标签提前闭合（gsap 里没有，但注入前统一处理） */
const escapeScriptText = (source: string): string => source.replaceAll('</script', '<\\/script')

/**
 * 组装沙箱文档。
 *
 * 顺序固定：基础样式 → 预置脚本 → 模型内容 → 高度回报脚本。
 *
 * 预置脚本必须在模型内容之前（模型的内联脚本一解析到就执行，库得先就位）；
 * 模型脚本写 `gsap.to(...)` 时 DOM 还不完整，要动元素就等 `DOMContentLoaded` 或用
 * `gsap.set` 之外的方式，围栏里我们只在提示词层提醒"先确认元素存在"。
 */
export const buildSandboxDocument = ({
  html,
  scripts = [],
  theme,
}: SandboxDocumentInput): string => {
  const baseStyle = [
    'html,body{margin:0;padding:0}',
    `body{padding:16px;background:${theme.background};color:${theme.color};`,
    "font-family:ui-sans-serif,system-ui,-apple-system,'PingFang SC',sans-serif;font-size:14px;line-height:1.6}",
    '*,*::before,*::after{box-sizing:border-box}',
    'img,video,svg,canvas{max-width:100%}',
  ].join('')

  const heightReporter = `(function(){var send=function(){try{parent.postMessage({__fenceHeight:document.documentElement.scrollHeight},'*')}catch(e){}};if(typeof ResizeObserver==='function'){new ResizeObserver(send).observe(document.documentElement)}else{setInterval(send,500)};addEventListener('load',send);send()})()`
  // 预览里的链接默认允许在 iframe 内部导航；相对链接会解析成父页面地址，一点就把预览替换成后台页面。
  // 只放行文档内锚点，其余链接一律拦截（不打开新窗口，避免 AI 内容借预览弹窗钓鱼）。
  const linkGuard = `(function(){document.addEventListener('click',function(event){var target=event.target;var anchor=target&&target.closest?target.closest('a[href]'):null;if(!anchor)return;var href=anchor.getAttribute('href')||'';event.preventDefault();if(href.charAt(0)!=='#')return;try{var id=decodeURIComponent(href.slice(1));var el=id?document.getElementById(id):document.body;if(el&&el.scrollIntoView)el.scrollIntoView({behavior:'smooth',block:'start'})}catch(e){}},true)})()`

  const inlineScripts = scripts
    .filter((source) => source.trim().length > 0)
    .map((source) => `<script>${escapeScriptText(source)}</script>`)
    .join('')

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${baseStyle}</style>`,
    inlineScripts,
    `<script>${escapeScriptText(linkGuard)}</script>`,
    '</head>',
    '<body>',
    html,
    `<script>${heightReporter}</script>`,
    '</body>',
    '</html>',
  ].join('')
}
