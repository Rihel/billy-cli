import type { ShareMetaModel } from '@repo/shared'
import { createServerClient } from '@/lib/server-client'
import { SharePreview } from '@/components/share-preview'

/**
 * 分享页（`/s/{token}`，设计 `docs/design/file-share.md` §6）。
 *
 * 服务端先取元信息（服务端到服务端调 `/share/meta`，URL 不进浏览器），
 * 再把「按 `previewKind` 渲染」交给客户端组件。
 *
 * 失败只有一种表现：中性的「链接已失效」。不区分「不存在 / 已过期 / 已撤销 / 文件已删」，
 * 也不透传后端的错误码 —— 页面里看不到任何系统内部信息。
 */
export const dynamic = 'force-dynamic'

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  let meta: ShareMetaModel | null = null
  try {
    meta = await createServerClient().share.meta({ token })
  } catch {
    meta = null
  }

  if (!meta) return <Invalid />

  return <SharePreview token={token} meta={meta} />
}

function Invalid() {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-4xl font-semibold text-muted-foreground">—</div>
      <h1 className="text-base font-medium">链接已失效</h1>
      <p className="text-sm text-muted-foreground">该分享可能已过期、已被撤销，或文件已被删除。</p>
    </div>
  )
}
