/**
 * User-Agent 解析（登录设备列表展示用）。
 *
 * 为什么手写而不是引库：只需要「浏览器 + 系统 + 设备类型」三行展示文案，用
 * `ua-parser-js` 这类库会引入一份完整指纹库与更新负担（够用就好，见设计文档）；
 * 认不出时**统一回落「未知」**，绝不猜。
 */

export interface UserAgentInfo {
  /** 浏览器 / 客户端名 */
  browser: string
  /** 操作系统 */
  os: string
  /** 设备类型：桌面 / 移动 / 平板 / 爬虫脚本 / 未知 */
  device: string
}

/** 识别顺序敏感：Edge / Opera / 微信 的 UA 里都含 Chrome，必须先判 */
const BROWSER_RULES: Array<[RegExp, string]> = [
  [/Edg[A-Z]?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/MicroMessenger/, '微信'],
  [/QQBrowser/, 'QQ 浏览器'],
  [/Firefox\//, 'Firefox'],
  [/Chrome\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

/** 识别顺序敏感：Windows 版本要先于通用 Windows，iOS 要先于 macOS（iPad 的 UA 含 Mac OS X） */
const OS_RULES: Array<[RegExp, string]> = [
  [/Windows NT 10\.0/, 'Windows 10/11'],
  [/Windows NT/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
]

/** 爬虫 / 脚本类客户端：设备类型单列，便于用户识别「这不是我的浏览器」 */
const BOT_RULE = /bot|crawler|spider|slurp|curl|wget|python-requests|node-fetch|undici|okhttp|go-http-client|headless/i

const UNKNOWN: UserAgentInfo = {
  browser: '未知浏览器',
  os: '未知系统',
  device: '未知设备',
}

/** 解析 UA → 展示用三要素（空 UA / 认不出都返回「未知」而非抛错） */
export const parseUserAgent = (userAgent?: string | null): UserAgentInfo => {
  const ua = userAgent?.trim()
  if (!ua) return { ...UNKNOWN }

  const isBot = BOT_RULE.test(ua)
  const browser = BROWSER_RULES.find(([pattern]) => pattern.test(ua))?.[1] ?? UNKNOWN.browser
  const os = OS_RULES.find(([pattern]) => pattern.test(ua))?.[1] ?? UNKNOWN.os

  let device: string
  if (isBot) device = '爬虫 / 脚本'
  else if (/iPad/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = '平板'
  else if (/Mobile|Android|iPhone/.test(ua)) device = '移动'
  else device = '桌面'

  return { browser, os, device }
}
