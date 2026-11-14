import dedent from 'dedent'
import { z } from 'zod'

export const WebRequestParams = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    .optional()
    .describe('请求地址（http / https，要带协议）。**首次请求必填**；只为了读下一页时可以省略'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
    .default('GET')
    .describe('HTTP 方法，默认 GET'),
  query: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('查询参数（自动 URL 编码）。地址里已经带 `?a=1` 也能用，这里的是补充 / 覆盖'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      '自定义请求头。默认已带好一整套浏览器头（UA / Accept / Accept-Language / Sec-Fetch-*），这里给的**会覆盖**同名默认项',
    ),
  body: z
    .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe(
      '请求体。字符串原样发；对象 / 数组自动转 JSON 并补 `Content-Type: application/json`。GET / HEAD 不能带',
    ),
  ref: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe('上一次请求返回的缓存句柄。**读后续页时传它**，服务端从缓存切片不再请求'),
  page: z.number().int().positive().default(1).describe('要第几页（从 1 开始，1 页 = 1000 行）'),
})

export const WEB_REQUEST_TOOL = {
  key: 'web-request',
  title: '发起 HTTP 请求（JSON API / 自定义方法与头）',
  category: 'core',
  scope: 'all',
  executor: 'worker',
  version: 1,
  params: WebRequestParams,
  description: dedent`
    发起一次 HTTP 请求（GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS），按页返回状态码、响应头与响应体。

    用在：目标是**接口** —— JSON API、要 POST、要看状态码、要自定义头、要读 RSS / XML。
    不用：只是读网页 → \`web-fetch\`（它会把 HTML 洗成 Markdown）。

    非 2xx 不算失败，状态码与响应体照样返回。续页用 \`ref\` + \`page\`。
    只请求需要的接口；不要外发响应里的凭据。
  `,
} as const
