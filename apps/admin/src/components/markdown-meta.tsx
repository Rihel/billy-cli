'use client'

import { cn } from '@repo/ui'

/**
 * Markdown 文件 frontmatter 的**元信息块**（文件预览弹窗与分享页共用）。
 *
 * 只展示 `name` 与 `description`：frontmatter 是给机器读的声明（技能名、触发描述），
 * 原样铺进正文就是把 YAML 当内容 —— 文件预览里真实踩过（`name:` / `description: >-`
 * 整段糊在标题前面）。
 *
 * 其余字段（version / license / 自定义键）不铺开：它们不是给人读的正文，
 * 想看原文切「代码」视图即可。
 */
export function MarkdownMeta({
  meta,
  className,
}: {
  meta: Record<string, string>
  className?: string
}) {
  const name = meta.name?.trim()
  const description = meta.description?.trim()
  if (!name && !description) return null
  return (
    <div className={cn('mb-4 rounded-lg border border-border/70 bg-muted/30 px-3 py-2', className)}>
      {name ? <div className="text-sm font-medium text-foreground">{name}</div> : null}
      {description ? (
        <p className="mt-1 text-xs leading-5 whitespace-pre-line text-muted-foreground">
          {description}
        </p>
      ) : null}
    </div>
  )
}
