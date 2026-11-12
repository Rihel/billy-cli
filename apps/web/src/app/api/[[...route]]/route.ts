import { handle } from '@hono/vercel'

import { app } from '@/api/app'

/**
 * Next API 层的路由入口（Hono 官方 Next.js 集成方式）。
 *
 * 所有接口都挂在这一条 catch-all 上：`/api/**` → `app.fetch(request)`。
 * 新增接口只改 `src/api/*`，**不用动这个文件**；只有用到新的 HTTP 方法时才在这里补一行 `export`。
 *
 * 为什么用 `nodejs` 运行时：接口要透传大文件流（`ReadableStream`）并读运行时环境变量，
 * Edge 运行时两者的能力都受限。
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = handle(app)
export const HEAD = handle(app)
export const POST = handle(app)
export const PUT = handle(app)
export const PATCH = handle(app)
export const DELETE = handle(app)
