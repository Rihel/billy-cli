'use client'

import { useState } from 'react'
import type { ToolPart } from '@repo/ui/components/ai-elements/tool.tsx'
import { Badge, Button } from '@repo/ui'
import { FileTextIcon, SparklesIcon } from 'lucide-react'
import { SkillPreviewDialog } from './skill-preview-dialog'
import { skillWriteOf, skillWriteStatusText, type SkillWriteDraft } from './skill-tool'

/**
 * 工具卡里的**技能写入摘要**：`skill-save` / `skill-import` 调用不再只给一坨 JSON，
 * 而是给一张"写了哪个技能 + 一键看内容"的卡。
 *
 * 为什么不直接铺正文：正文可能几千字，铺在对话里会把上下文冲掉；摘要 + 右侧抽屉
 * 既让过程可见，又把"细读"留给用户按需打开。
 */
export function SkillToolSummary({ part }: { part: ToolPart }) {
  const info = skillWriteOf(part)
  const [viewing, setViewing] = useState<{ skillKey: string; draft?: SkillWriteDraft } | null>(null)

  if (!info) return null

  const isSave = info.tool === 'skill-save'
  const failed = part.state === 'output-error'
  const headline = failed
    ? isSave
      ? '技能写入失败'
      : '技能导入失败'
    : !info.finished
      ? isSave
        ? '正在写入技能库…'
        : '正在从链接导入…'
      : isSave
        ? info.entries[0]?.status === 'created'
          ? '已新建技能'
          : '已更新技能'
        : '已从链接导入'

  return (
    <>
      <div className="rounded-lg border border-brand/25 bg-brand/5 px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <SparklesIcon className="size-3.5 text-brand" />
          <span className="font-medium">{headline}</span>
          {info.source ? (
            <span className="max-w-[320px] truncate font-mono text-[10px] text-muted-foreground">
              {info.source}
            </span>
          ) : null}
          {isSave && info.draft ? (
            <span className="text-[10px] text-muted-foreground">
              {1 + info.draft.files.length} 个文件
            </span>
          ) : null}
        </div>

        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {info.entries.map((entry) => {
            const statusText = skillWriteStatusText(entry.status)
            return (
              <Button
                key={entry.skillKey}
                type="button"
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={entry.status === 'failed'}
                onClick={() =>
                  setViewing({
                    skillKey: entry.skillKey,
                    ...(isSave && info.draft ? { draft: info.draft } : {}),
                  })
                }
              >
                <FileTextIcon className="size-3.5" />
                <span className="font-mono text-[11px]">{entry.skillKey}</span>
                {statusText ? (
                  <Badge variant="secondary" className="px-1 py-0 text-[9px]">
                    {statusText}
                  </Badge>
                ) : null}
              </Button>
            )
          })}
          {info.entries.length === 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {failed ? '没有可查看的技能' : '等待导入结果…'}
            </span>
          ) : null}
        </div>
      </div>

      <SkillPreviewDialog
        open={viewing !== null}
        skillKey={viewing?.skillKey ?? ''}
        {...(viewing?.draft ? { draft: viewing.draft } : {})}
        {...(info.source ? { source: info.source } : {})}
        onOpenChange={(next) => {
          if (!next) setViewing(null)
        }}
      />
    </>
  )
}
