import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { ToolDeniedError } from '../../core/tools/tools.types.js'

/**
 * **出网层**：`web-fetch` 与 `web-request` 共用的唯一一处 HTTP 出口。
 *
 * 为什么两个工具都要走这里（而不是各自 `fetch` 一下）：
 * - **身份必须一致**：同一套浏览器 UA + 常用请求头，站点看到的是"一个浏览器"而不是"一堆奇怪的客户端"。
 *   分头写必然漂移（一个带 UA、一个忘带，然后其中某个工具在同一个站上被 403）；
 * - **预算必须一致**：超时、最多读多少字节、是否允许访问内网，都只有一处口径；
 * - **重定向必须自己走**：`redirect: 'follow'` 会把每一跳的目标交给 undici，
 *   于是"内网地址拦截"只在第一跳有效 —— 一个公网跳转页就能把它绕过去。
 *   这里用 `redirect: 'manual'` 逐跳校验，逐跳带同一份头。
 *
 * 安全边界如实记录：这不是沙箱。拦截的对象是"模型可能被网页内容诱导去访问的内网地址"
 * （`127.0.0.1`、`10/8`、云厂商元数据 `169.254.169.254` 之类），拦法是
 * **域名先看后缀、再做一次 DNS 解析、解析出的每个地址都必须是公网**。
 * 真要严防 SSRF，得把出网放到带出口白名单的代理里（那是另一件事，不在本文件假装做到）。
 */

/**
 * **统一浏览器 UA**（Chrome on Windows）。
 *
 * 固定写一份而不是读环境：读环境就会"这台机器一个 UA、那台机器一个 UA"，
 * 排障时看到的失败无法复现。要换身份就改工具的 `userAgent` 配置（全局限一处）。
 */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/**
 * 浏览器会带的头（按顺序固定）。
 *
 * `Sec-Fetch-*` 与 `sec-ch-ua` 是真实浏览器必带的客户端提示，缺了它们
 * 一部分站点（尤其是有 WAF 的）会直接回 403 —— 这不是伪装，是"像浏览器一样请求"的最低要求。
 */
export const browserHeaders = (
  userAgent: string,
  extra?: Record<string, string>,
): Record<string, string> => ({
  'User-Agent': userAgent,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': '"Chromium";v="141", "Google Chrome";v="141", "Not?A_Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  // 调用方给的头**覆盖**默认值：要自定义 Referer / Cookie / Authorization 就靠这一层
  ...(extra ?? {}),
})

/** 一次出网的预算（全部由工具配置夹好，这里只消费） */
export interface WebRequestOptions {
  method?: string
  headers: Record<string, string>
  body?: string
  /** 总时长上限（ms）：**整条重定向链共用这一个预算**，不是每一跳各给一份 */
  timeoutMs: number
  /** 最多读多少字节（超出的部分丢弃并标记 `truncated`） */
  maxBytes: number
  /** 允许访问内网 / 回环地址（只在自用环境打开） */
  allowPrivateNetwork: boolean
  signal?: AbortSignal
}

/** 出网结果（原始文本 + 事实性元信息；转 Markdown / 分页在上层做） */
export interface WebResponse {
  /** 第一跳的地址（模型传进来的那个） */
  url: string
  /** 实际取到内容的地址（跟完重定向之后） */
  finalUrl: string
  /** 重定向了几跳 */
  redirects: number
  status: number
  statusText: string
  method: string
  contentType: string
  /** 白名单里的响应头（`set-cookie` 之类一律不回给模型） */
  headers: Record<string, string>
  /** 解码后的文本（按响应声明的字符集解，缺省 UTF-8） */
  text: string
  /** 实际读到的字节数 */
  bytes: number
  /** 是不是因为到达上限被截断 */
  truncated: boolean
}

/** 只回给模型这几项响应头：多了是噪音，`set-cookie` / `authorization` 是凭据不许外带 */
const REPORTED_HEADERS = [
  'content-type',
  'content-length',
  'location',
  'content-language',
  'cache-control',
  'etag',
  'last-modified',
  'server',
  'x-request-id',
] as const

/** 会被跟的重定向状态码 */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

/** 最多跟几跳（浏览器大致也是这个量级；再多基本是循环重定向） */
const MAX_REDIRECTS = 5

const denied = (message: string, hint?: string): ToolDeniedError =>
  new ToolDeniedError('invalid-input', message, hint)

// ─────────────────────────── 内网地址判定 ───────────────────────────

/** IPv4 → 32 位整数（不合法返回 null） */
const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

/** 不允许出网的 IPv4 网段（云元数据 `169.254.169.254` 落在链路本地里，一并挡住） */
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]

const inV4Range = (ip: number, base: string, bits: number): boolean => {
  const baseInt = ipv4ToInt(base) ?? 0
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return ((ip & mask) >>> 0) === ((baseInt & mask) >>> 0)
}

/** 是不是内网 / 回环 / 保留地址（认不出来的按不可访问处理：宁可拒绝，不要打穿） */
export const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address)
  if (version === 4) {
    const ip = ipv4ToInt(address)
    if (ip === null) return true
    return BLOCKED_V4.some(([base, bits]) => inV4Range(ip, base, bits))
  }
  if (version === 6) {
    const lower = address.toLowerCase()
    // IPv4 映射地址（`::ffff:127.0.0.1`）按里层的 v4 判
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
    if (mapped?.[1]) return isPrivateAddress(mapped[1])
    if (lower === '::' || lower === '::1') return true
    if (/^f[cd]/.test(lower)) return true // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(lower)) return true // fe80::/10 链路本地
    return false
  }
  return true
}

/** 这些后缀只可能解析到本机 / 局域网 */
const BLOCKED_HOST_SUFFIX = ['.localhost', '.local', '.internal', '.home.arpa', '.lan']

/**
 * **出网前的一道闸**：协议 + 主机名 + DNS 解析结果。
 *
 * 为什么必须解析一次 DNS：`http://127.0.0.1` 一眼能看出来，
 * 但 `http://foo.example.com`（A 记录指向 `127.0.0.1`）看不出来 —— 而后者正是
 * 常见 SSRF 手法。解析失败不在这里拦（交给 fetch 报真实原因），解析成功则**每个**地址都要过。
 */
export const assertFetchable = async (url: URL, allowPrivate: boolean): Promise<void> => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw denied(`只支持 http / https，收到的是 ${url.protocol}`, '换成网页地址再试')
  }
  if (allowPrivate) return

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) throw denied('地址里没有主机名')
  if (host === 'localhost' || BLOCKED_HOST_SUFFIX.some((suffix) => host.endsWith(suffix))) {
    throw denied(
      `拒绝访问 ${host}：本机 / 局域网地址不在允许范围内`,
      '要抓本机的服务，把工具配置里的 allowPrivateNetwork 打开',
    )
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw denied(
        `拒绝访问 ${host}：这是内网 / 回环 / 保留地址`,
        '要抓本机的服务，把工具配置里的 allowPrivateNetwork 打开',
      )
    }
    return
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    // 解析不了：让 fetch 去报它自己的错（DNS 失败 / 域名不存在），比这里猜一句更有用
    return
  }
  const blocked = addresses.find((entry) => isPrivateAddress(entry.address))
  if (blocked) {
    throw denied(
      `拒绝访问 ${host}：它解析到了内网地址 ${blocked.address}`,
      '要抓本机的服务，把工具配置里的 allowPrivateNetwork 打开',
    )
  }
}

// ─────────────────────────── 读响应 ───────────────────────────

/**
 * 按字节上限读流。
 *
 * 为什么要流式读而不是 `res.text()`：`res.text()` 会把整份响应读进内存 ——
 * 一个 500MB 的文件、或者一个不会结束的 SSE 流，都能把服务拖死。
 * 读到上限就 `cancel()`，剩下的字节让它留在网络上。
 */
const readCapped = async (
  res: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; bytes: number; truncated: boolean }> => {
  const body = res.body
  if (!body) return { buffer: Buffer.alloc(0), bytes: 0, truncated: false }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    const room = maxBytes - received
    if (value.byteLength >= room) {
      if (room > 0) chunks.push(Buffer.from(value.buffer, value.byteOffset, room))
      received += Math.max(0, Math.min(room, value.byteLength))
      truncated = value.byteLength > room
      try {
        await reader.cancel()
      } catch {
        // 取消失败无所谓：已经读到上限，连接会被丢弃
      }
      break
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength))
    received += value.byteLength
  }
  return { buffer: Buffer.concat(chunks), bytes: received, truncated }
}

/** 响应声明的字符集（GBK 页面不少，按 UTF-8 硬解会整页是问号） */
const resolveCharset = (buffer: Buffer, contentType: string): string => {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader.toLowerCase()
  const head = buffer.subarray(0, 4096).toString('latin1')
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1]
  return (fromMeta ?? 'utf-8').toLowerCase()
}

const decodeBuffer = (buffer: Buffer, contentType: string): string => {
  const charset = resolveCharset(buffer, contentType)
  try {
    return new TextDecoder(charset).decode(buffer)
  } catch {
    // 不认识的字符集标签（如 `charset=x-user-defined`）按 UTF-8 解，别整份丢
    return new TextDecoder('utf-8').decode(buffer)
  }
}

const pickHeaders = (headers: Headers): Record<string, string> => {
  const picked: Record<string, string> = {}
  for (const name of REPORTED_HEADERS) {
    const value = headers.get(name)
    if (value) picked[name] = value
  }
  return picked
}

/** 把 fetch 抛出的东西翻成"能读懂、可纠正"的结论（超时 / 连接失败 / 被中止） */
const wrapFetchError = (error: unknown, url: string, timeoutMs: number): ToolDeniedError => {
  if (error instanceof ToolDeniedError) return error
  const err = error as { name?: string; message?: string; cause?: { code?: string; message?: string } }
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return denied(
      `请求 ${url} 超时（${timeoutMs}ms 内没有拿到完整响应）`,
      '站点可能很慢或不可达；换个来源，或把工具配置里的 timeoutMs 调大',
    )
  }
  const code = err?.cause?.code ?? ''
  const detail = err?.cause?.message ?? err?.message ?? String(error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return denied(`域名解析失败：${url}（${detail}）`, '检查域名拼写；也可能是本机 DNS 不可用')
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return denied(`连接失败：${url}（${code}）`, '目标站点拒绝连接或网络不通，换来源或稍后重试')
  }
  return denied(
    `请求失败：${url}（${detail}）`,
    '站点可能不可达或被墙；换一个来源，或如实告诉用户"这个站点抓不到"',
  )
}

// ─────────────────────────── 出网 ───────────────────────────

/**
 * 发一次请求（**逐跳自己跟重定向**），拿到解码后的文本。
 *
 * 非 2xx **不抛错**：404 的正文、500 的错误页、429 的说明，对模型都是有信息量的结论，
 * 由上层按 `status` 决定怎么说。抛错只发生在"连不上"这类拿不到任何内容的情况下。
 */
export const fetchGuarded = async (
  start: string,
  options: WebRequestOptions,
): Promise<WebResponse> => {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout

  let url = start
  let method = (options.method ?? 'GET').toUpperCase()
  let body = options.body
  const headers = { ...options.headers }
  let redirects = 0

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw denied(`不是合法的 URL：${url}`, '要带协议的完整地址，例如 https://example.com/a')
    }
    await assertFetchable(target, options.allowPrivateNetwork)

    let res: Response
    try {
      res = await fetch(target, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      throw wrapFetchError(error, target.href, options.timeoutMs)
    }

    if (REDIRECT_STATUS.has(res.status)) {
      const location = res.headers.get('location')
      if (location) {
        try {
          await res.body?.cancel()
        } catch {
          // 丢掉这一跳的响应体即可，失败不影响后面
        }
        const next = new URL(location, target)
        // 浏览器行为：303 一律转 GET；301/302 上的 POST 也降级成 GET；307/308 原样重放
        const downgrade =
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')
        if (downgrade) {
          method = 'GET'
          body = undefined
          delete headers['content-type']
          delete headers['Content-Type']
        }
        url = next.href
        redirects += 1
        continue
      }
      // 没有 Location 的 3xx：当作最终响应处理（下面照常读）
    }

    const contentType = res.headers.get('content-type') ?? ''
    const { buffer, bytes, truncated } = await readCapped(res, options.maxBytes)
    return {
      url: start,
      finalUrl: target.href,
      redirects,
      status: res.status,
      statusText: res.statusText,
      method,
      contentType,
      headers: pickHeaders(res.headers),
      text: decodeBuffer(buffer, contentType),
      bytes,
      truncated,
    }
  }

  throw denied(
    `重定向超过 ${MAX_REDIRECTS} 跳，已停止（最终停在 ${url}）`,
    '这个地址可能在循环跳转；换一个直链来源',
  )
}
