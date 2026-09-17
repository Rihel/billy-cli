import { describe, expect, it } from 'vitest'
import { parseUserAgent } from '../src/utils/user-agent.utils'

/** 真实浏览器 UA 片段（取主流形态，避免把识别顺序写反） */
const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  curl: 'curl/8.7.1',
  bot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
}

describe('parseUserAgent', () => {
  it('空 UA → 全部「未知」，不抛错', () => {
    expect(parseUserAgent(null)).toEqual({
      browser: '未知浏览器',
      os: '未知系统',
      device: '未知设备',
    })
    expect(parseUserAgent('   ').browser).toBe('未知浏览器')
  })

  it('Chrome / Windows 桌面', () => {
    expect(parseUserAgent(UA.chromeWin)).toEqual({
      browser: 'Chrome',
      os: 'Windows 10/11',
      device: '桌面',
    })
  })

  it('Edge 不被识别成 Chrome（识别顺序敏感）', () => {
    expect(parseUserAgent(UA.edgeWin).browser).toBe('Edge')
  })

  it('Safari / macOS', () => {
    expect(parseUserAgent(UA.safariMac)).toEqual({
      browser: 'Safari',
      os: 'macOS',
      device: '桌面',
    })
  })

  it('Firefox / Linux', () => {
    expect(parseUserAgent(UA.firefoxLinux)).toEqual({
      browser: 'Firefox',
      os: 'Linux',
      device: '桌面',
    })
  })

  it('微信内置浏览器 + Android 移动端', () => {
    expect(parseUserAgent(UA.wechatAndroid)).toEqual({
      browser: '微信',
      os: 'Android',
      device: '移动',
    })
  })

  it('iPhone → 移动；iPad → 平板（且不被识别成 macOS）', () => {
    expect(parseUserAgent(UA.iphone)).toEqual({ browser: 'Safari', os: 'iOS', device: '移动' })
    expect(parseUserAgent(UA.ipad)).toEqual({ browser: 'Safari', os: 'iOS', device: '平板' })
  })

  it('Android 平板（UA 无 Mobile）→ 平板', () => {
    expect(parseUserAgent(UA.androidTablet).device).toBe('平板')
  })

  it('脚本 / 爬虫单列设备类型（便于识别「不是我的浏览器」）', () => {
    expect(parseUserAgent(UA.curl).device).toBe('爬虫 / 脚本')
    expect(parseUserAgent(UA.bot).device).toBe('爬虫 / 脚本')
  })
})
