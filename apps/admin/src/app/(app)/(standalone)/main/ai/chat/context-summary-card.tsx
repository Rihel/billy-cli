'use client'

import { Markdown } from '@repo/ui'
import { ArchiveIcon } from 'lucide-react'

/**
 * 会话里的「已压缩早期对话」卡片（设计 `docs/design/ai-memory.md` §4.2 / ai-agent.md §3.9）。
 *
 * 为什么放在消息流里：摘要会替换模型看到的早期历史，用户需要一个显式的锚点知道
 * "这一段被压过、原文还在库里"；正文默认折叠，想看再展开。
 */
export function ContextSummaryCard({ text, covers }: { text: string; covers?: string }) {
  return (
    <details className="rounded-md bg-surface-1 px-3 py-2">
      <summary className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <ArchiveIcon className="size-3.5 shrink-0" />
        <span>已压缩早期对话{covers ? `（第 ${covers} 条）` : ''}</span>
      </summary>
      <div className="mt-2 text-sm">
        <Markdown content={text} />
      </div>
    </details>
  )
}
