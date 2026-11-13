import { browserHeaders, fetchGuarded } from './http.js'

/**
 * **已知站点的抓取兜底**。
 *
 * 为什么需要这一层：有些站点（百度百科）对**任何**非浏览器请求都回 403 人机验证页 ——
 * 换 UA、换移动端入口、换爬虫身份都试过，一律被拦。但它们**同时**提供公开的摘要接口。
 * 与其让模型拿到一句"抓不到"然后反复重试，不如走官方接口把摘要拿回来。
 *
 * 三条边界（破坏任何一条都宁可不用）：
 * 1. **只在直接抓被拦时才走兜底**：站点哪天开放了，会自动回落到正常路径；
 * 2. **必须如实标注拿到的是什么**：百度百科这条给的是**摘要卡片**，不是正文全文。
 *    写成"全文"就是骗模型 —— 它会以为自己读完了整篇；
 * 3. **兜底失败就当没有**：接口挂了 / 词条不存在，照常报"抓不到"，绝不拿半截内容凑数。
 */

/** 兜底结果（拿不到返回 null） */
export interface SiteFallbackResult {
  /** Markdown 正文 */
  text: string
  title: string | null
  /** 说明这份内容是怎么来的、与原文差在哪（给模型，也给人看） */
  note: string
}

export interface SiteFallback {
  /** 站点名（日志与出参里说明"走了哪条路"） */
  readonly name: string
  /** 这个地址归不归我管 */
  match(url: URL): boolean
  fetch(
    url: URL,
    options: { userAgent: string; timeoutMs: number; maxBytes: number },
  ): Promise<SiteFallbackResult | null>
}

/** 去标签：接口返回的字段值里夹着 `<a href="/item/TCP">TCP</a>` 这类内链 */
const stripTags = (html: string): string =>
  html
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Markdown 表格里的竖线会把表格切坏 */
const cell = (text: string): string => stripTags(text).replace(/\|/g, '\\|')

/**
 * 百度百科公开摘要接口（`appid` 是它自己页面上在用的那个）。
 *
 * 返回的是**词条卡片**：一句话描述 + 一段摘要 + 若干"字段 / 值" + 目录。
 * 够回答"这是什么 / 基本属性"，**不够**替代正文（没有完整论述、没有图、没有参考文献）。
 */
const BAIKE_API = 'https://baike.baidu.com/api/openapi/BaikeLemmaCardApi'
const BAIKE_APPID = '379020'

interface BaikeCard {
  title?: string
  desc?: string
  abstract?: string
  card?: Array<{ name?: string; value?: string[] }>
  catalog?: string[]
}

const baike: SiteFallback = {
  name: '百度百科公开摘要接口',
  match: (url) =>
    /(^|\.)baike\.baidu\.com$/.test(url.hostname) && url.pathname.startsWith('/item/'),
  fetch: async (url, options) => {
    // `/item/HTTP/243074` → `HTTP`（后面那段是 lemmaId，接口只认词条名）
    const lemma = decodeURIComponent(url.pathname.replace(/^\/item\//, '').split('/')[0] ?? '')
    if (!lemma) return null

    const api = new URL(BAIKE_API)
    api.searchParams.set('scope', '103')
    api.searchParams.set('format', 'json')
    api.searchParams.set('appid', BAIKE_APPID)
    api.searchParams.set('bk_key', lemma)
    api.searchParams.set('bk_length', '600')

    // 走同一条出网通道（同样 UA / 预算 / 内网闸）：兜底不是特权通道
    const res = await fetchGuarded(api.href, {
      headers: { ...browserHeaders(options.userAgent), Accept: 'application/json,*/*;q=0.8' },
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      allowPrivateNetwork: false,
    })
    if (res.status !== 200) return null

    let data: BaikeCard
    try {
      data = JSON.parse(res.text) as BaikeCard
    } catch {
      return null
    }
    // 词条不存在时接口回 `{}`：这不是"内容少"，是"没有这个词条"
    if (!data.title && !data.abstract && !data.desc) return null

    const lines: string[] = [`# ${data.title ?? lemma}`, '']
    const summary = (data.abstract ?? data.desc ?? '').trim()
    if (summary) lines.push(summary, '')

    const fields = (data.card ?? []).filter((item) => item.name && item.value?.length)
    if (fields.length) {
      lines.push('## 基本信息', '', '| 字段 | 值 |', '| --- | --- |')
      for (const item of fields) {
        const value = (item.value ?? []).map(cell).filter(Boolean).join('；')
        if (value) lines.push(`| ${cell(item.name ?? '')} | ${value} |`)
      }
      lines.push('')
    }

    const catalog = (data.catalog ?? []).map(stripTags).filter(Boolean)
    if (catalog.length) {
      lines.push('## 目录', '', ...catalog.map((entry) => `- ${entry}`), '')
    }

    return {
      text: lines.join('\n'),
      title: data.title ?? lemma,
      note:
        '词条正文有人机验证（403），静态抓取拿不到；这份是百度百科**公开摘要接口**返回的内容（一句话描述 + 摘要 + 基本信息 + 目录），' +
        '**不是正文全文** —— 要完整论述、图表或参考文献，换一个来源（如维基百科 / 官方文档）',
    }
  },
}

/** 站点兜底清单（按顺序匹配，第一个命中的生效） */
export const SITE_FALLBACKS: readonly SiteFallback[] = [baike]
