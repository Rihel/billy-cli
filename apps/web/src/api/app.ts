import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'

import { shareRoutes } from './share'

/**
 * Next API 层的唯一入口（按 Hono 官方 Next.js 集成方式）：
 *
 * ```
 * app/api/[[...route]]/route.ts   →  handle(app)
 * ```
 *
 * 约定：
 * - **basePath 与全局中间件集中在这里**，各能力模块（`share.ts` 等）只管自己的路径；
 * - 新增能力 = 写一个 `xxxRoutes` 模块，在这里 `app.route('/xxx', xxxRoutes)`；
 * - 业务与中间件都在 Hono 里，单测可以 `app.request(new Request(...))`，不用起 Next。
 *
 * `secureHeaders` 的取值理由：
 * - `xFrameOptions: SAMEORIGIN`：PDF 走同源 iframe 预览，`DENY` 会把自己的预览框也拦掉；
 * - `referrerPolicy: no-referrer`：分享 token 在路径里，页面里任何外链都不能把 Referer 带出去；
 * - `removePoweredBy`：不留框架指纹。
 */
export const app = new Hono().basePath('/api')

app.use(
  '*',
  secureHeaders({
    referrerPolicy: 'no-referrer',
    xContentTypeOptions: 'nosniff',
    xFrameOptions: 'SAMEORIGIN',
    crossOriginResourcePolicy: 'same-origin',
    removePoweredBy: true,
  }),
)

app.route('/s', shareRoutes)
