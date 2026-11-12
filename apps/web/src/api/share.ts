import { Hono } from 'hono'

import { ServerUrl } from '@/lib/constants'

/**
 * 分享相关的 API 路由（挂载点见 `api/app.ts`：`/api/s/*`）。
 *
 * 这里**只做字节转发**：token 校验、文件元数据、预签名 URL 都在 server（数据在库里的那一侧）。
 * 浏览器全程只看得到 `/api/s/{token}/content`，看不到 OSS 域名与签名参数。
 *
 * 约定：路由模块只声明自己的路径，**basePath 与中间件统一由 `api/app.ts` 装配** ——
 * 这样新增能力时不会各写一套安全头。
 */

/** 服务端 `/share/resolve` 的返回（已剥掉 `{ code, data }` 信封） */
type ResolvedShare = {
  url: string
  filename: string
  mediaType: string
  bytes: number
}

/** 允许浏览器内联渲染的类型；其余一律当附件下载（HTML / SVG 同域内联 = 存储型 XSS） */
const INLINE_SAFE: ((mediaType: string) => boolean) = (mediaType) => {
  if (mediaType.startsWith('image/')) return mediaType !== 'image/svg+xml'
  if (mediaType.startsWith('video/')) return true
  if (mediaType.startsWith('audio/')) return true
  return (
    mediaType === 'application/pdf' ||
    mediaType === 'text/plain' ||
    mediaType === 'text/csv'
  )
}

const contentDisposition = (mediaType: string, filename: string): string => {
  const safe = filename.replace(/[\r\n"\\]/g, '_').trim() || 'file'
  const kind = INLINE_SAFE(mediaType) ? 'inline' : 'attachment'
  return `${kind}; filename*=UTF-8''${encodeURIComponent(safe)}`
}

/**
 * 用 token 换一次预签名 URL（服务端到服务端）。
 *
 * 未配置内部密钥 = 分享能力未开启，返回 null 由调用方统一 404 ——
 * 与「对象存储未配置不拦启动」同一姿态：能力缺失不当成错误抛给访问者。
 */
const resolveShare = async (token: string): Promise<ResolvedShare | null> => {
  const secret = process.env.SHARE_INTERNAL_SECRET
  if (!secret) return null

  const response = await fetch(`${ServerUrl}/share/resolve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-share-internal': secret,
    },
    body: JSON.stringify({ token }),
    cache: 'no-store',
  })
  if (!response.ok) return null

  const payload = (await response.json()) as {
    code?: number
    data?: ResolvedShare
  }
  return payload.code === 0 && payload.data ? payload.data : null
}

const notFound = (): Response => new Response(null, { status: 404 })

export const shareRoutes = new Hono()

shareRoutes.on(['GET', 'HEAD'], '/:token/content', async (c) => {
  const token = c.req.param('token')
  // token 是 32 字符的 base64url；长度明显不对就不必往服务端跑一趟
  if (!token || token.length > 128) return notFound()

  const resolved = await resolveShare(token).catch(() => null)
  if (!resolved) return notFound()

  const range = c.req.header('range')
  const upstream = await fetch(resolved.url, {
    method: c.req.method === 'HEAD' ? 'HEAD' : 'GET',
    ...(range ? { headers: { range } } : {}),
    cache: 'no-store',
  })
  // 206 也是正常结果（分段请求）
  if (!upstream.ok && upstream.status !== 206) return notFound()

  const headers = new Headers({
    'content-type': resolved.mediaType,
    'content-disposition': contentDisposition(resolved.mediaType, resolved.filename),
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=300',
    'x-robots-tag': 'noindex, nofollow',
  })
  // 透传长度 / 分段 / 校验头，浏览器靠它们拖进度条和判断缓存
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }

  // 直接透传流，绝不 await arrayBuffer()：大文件会把 Next 进程的内存打爆
  return new Response(c.req.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    headers,
  })
})
