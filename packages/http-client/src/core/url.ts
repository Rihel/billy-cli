/** 拼接 baseUrl + path + 查询参数（HttpClient 与 HttpTransport 共用，避免两套 URL 语义漂移）。 */
export const buildRequestUrl = (
  baseUrl: string,
  path: string,
  params?: Record<string, any>,
): string => {
  const url = resolveUrl(baseUrl, path)
  appendSearchParams(url, params)
  return url.toString()
}

/** 完整 URL 直接使用；相对路径拼接在 baseUrl 的 path 之后。 */
const resolveUrl = (baseUrl: string, path: string): URL => {
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(path)) {
    return baseUrl ? new URL(path, baseUrl) : new URL(path)
  }
  if (path.startsWith('//')) return new URL(path, baseUrl)
  if (!baseUrl) throw new Error('缺少 baseUrl，无法解析相对路径')
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const parsed = new URL(path.startsWith('/') ? path : `/${path}`, baseUrl)
  url.pathname = `${basePath}${parsed.pathname}`
  if (parsed.search) url.search = parsed.search
  if (parsed.hash) url.hash = parsed.hash
  return url
}

/** 查询参数：过滤 undefined/null、数组展开为重复键、对象 JSON 序列化。 */
const appendSearchParams = (url: URL, params?: Record<string, any>): void => {
  if (!params) return
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue
        url.searchParams.append(key, serializeParam(item))
      }
      continue
    }
    url.searchParams.append(key, serializeParam(value))
  }
}

const serializeParam = (value: unknown): string => {
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
