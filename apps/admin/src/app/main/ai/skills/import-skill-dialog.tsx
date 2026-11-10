'use client'

import { useEffect, useMemo, useState } from 'react'
import type {
  AiSkillImportDto,
  AiSkillImportItemModel,
  AiSkillImportPreviewResultModel,
  AiSkillImportResultModel,
} from '@repo/shared'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Switch,
  Tag,
} from '@repo/ui'
import { LinkIcon, RefreshCwIcon } from 'lucide-react'

/**
 * 从链接导入技能（**下载后写入库**）：
 * 支持 skills.sh 技能页、GitHub 仓库 / 目录 / 文件链接，以及 `owner/repo` 简写。
 *
 * 两步而不是一步：**先预览**这个链接里有哪些技能、哪些已存在，再勾选要导的。
 * 一个 GitHub 仓库常常有十几个技能，直接"全导进来"是灾难。
 */
export interface ImportSkillDialogProps {
  open: boolean
  /** 请求在飞：预览 / 导入任一 */
  busy: boolean
  previewing: boolean
  preview: AiSkillImportPreviewResultModel | null
  result: AiSkillImportResultModel | null
  onClose: () => void
  onPreview: (url: string) => Promise<void>
  onImport: (dto: AiSkillImportDto) => Promise<void>
}

const statusLabel: Record<AiSkillImportItemModel['status'], { text: string; color: string }> = {
  created: { text: '已导入', color: 'success' },
  updated: { text: '已覆盖', color: 'processing' },
  skipped: { text: '已跳过', color: 'default' },
  failed: { text: '失败', color: 'error' },
}

export function ImportSkillDialog({
  open,
  busy,
  previewing,
  preview,
  result,
  onClose,
  onPreview,
  onImport,
}: ImportSkillDialogProps) {
  const [url, setUrl] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return
    setUrl('')
    setOverwrite(false)
    setSelected(new Set())
  }, [open])

  // 预览回来：默认勾选"库里还没有"的技能；已存在的要显式开覆盖才能勾
  useEffect(() => {
    if (!preview) return
    setSelected(new Set(preview.skills.filter((skill) => !skill.exists).map((skill) => skill.skillKey)))
  }, [preview])

  // 关掉覆盖时，把已存在的从选择里摘掉（避免"看着没勾覆盖却把别人覆盖了"）
  useEffect(() => {
    if (overwrite || !preview) return
    setSelected((current) => {
      const next = new Set(current)
      for (const skill of preview.skills) if (skill.exists) next.delete(skill.skillKey)
      return next
    })
  }, [overwrite, preview])

  const toggle = (skillKey: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(skillKey)) next.delete(skillKey)
      else next.add(skillKey)
      return next
    })
  }

  const canPreview = url.trim().length > 3 && !busy
  const canImport = Boolean(preview) && selected.size > 0 && !busy

  const importSelected = async (): Promise<void> => {
    if (!preview || selected.size === 0) return
    await onImport({
      url: url.trim(),
      overwrite,
      ...(selected.size < preview.skills.length ? { skillKeys: [...selected] } : {}),
    })
  }

  const selectAll = (): void => {
    if (!preview) return
    setSelected(
      new Set(
        preview.skills
          .filter((skill) => !skill.exists || overwrite)
          .map((skill) => skill.skillKey),
      ),
    )
  }

  const summary = useMemo(() => {
    if (!preview) return null
    return `${preview.skills.length} 个技能 · 已存在 ${preview.skills.filter((skill) => skill.exists).length} 个`
  }, [preview])

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>从链接导入技能</DialogTitle>
          <DialogDescription>
            贴 skills.sh 技能页、GitHub 仓库 / 目录链接，或 <code>owner/repo</code> 简写。
            服务端会下载技能内容，校验后写入技能库并落盘。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <LinkIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={url}
                placeholder="https://skills.sh/vercel-labs/skills/find-skills"
                className="pl-8"
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && canPreview) void onPreview(url.trim())
                }}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!canPreview}
              onClick={() => void onPreview(url.trim())}
            >
              <RefreshCwIcon className={previewing ? 'animate-spin' : undefined} />
              {previewing ? '解析中…' : '预览'}
            </Button>
          </div>

          <div className="flex items-center justify-between rounded-lg bg-surface-1 px-4 py-2.5">
            <div className="flex flex-col">
              <span className="text-sm font-medium">覆盖同名技能</span>
              <span className="text-xs text-muted-foreground">
                不勾选时同名技能不能选；勾选后可整体替换（含文件集合）
              </span>
            </div>
            <Switch
              checked={overwrite}
              onCheckedChange={(checked) => setOverwrite(checked === true)}
            />
          </div>

          {preview ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-mono text-muted-foreground">{preview.source}</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {summary}
                  <Button type="button" size="sm" variant="ghost" onClick={selectAll}>
                    全选可导的
                  </Button>
                </span>
              </div>
              <div className="flex max-h-72 flex-col gap-1 overflow-auto rounded-lg border p-2">
                {preview.skills.map((skill) => {
                  const disabled = skill.exists && !overwrite
                  return (
                    <Label
                      key={skill.skillKey}
                      className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${
                        disabled ? 'opacity-50' : 'cursor-pointer hover:bg-surface-1'
                      }`}
                    >
                      <Checkbox
                        checked={selected.has(skill.skillKey)}
                        disabled={disabled || busy}
                        onCheckedChange={() => toggle(skill.skillKey)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-center gap-1.5">
                          <span className="font-mono text-xs">{skill.skillKey}</span>
                          {skill.exists ? <Tag color="warning">已存在</Tag> : null}
                          <span className="text-[10px] text-muted-foreground">
                            {skill.fileCount} 个文件
                          </span>
                        </span>
                        <span className="line-clamp-2 text-[11px] text-muted-foreground">
                          {skill.description}
                        </span>
                      </span>
                    </Label>
                  )
                })}
                {preview.failures.map((failure) => (
                  <div key={failure.skillKey} className="flex items-start gap-2 px-2 py-1 text-xs">
                    <Tag color="error">失败</Tag>
                    <span className="font-mono">{failure.skillKey}</span>
                    <span className="text-muted-foreground">{failure.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {result ? (
            <div className="flex max-h-56 flex-col gap-1 overflow-auto rounded-lg border bg-surface-1 p-2">
              <p className="px-1 text-[11px] font-medium text-muted-foreground">
                导入结果 · {result.source}（{result.items.filter((item) => item.status !== 'failed').length}{' '}
                / {result.total} 成功）
              </p>
              {result.items.map((item) => (
                <div key={item.skillKey} className="flex items-start gap-2 px-1 text-xs">
                  <Tag color={statusLabel[item.status].color}>{statusLabel[item.status].text}</Tag>
                  <span className="font-mono">{item.skillKey}</span>
                  {item.message ? (
                    <span className="text-muted-foreground">{item.message}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <Button type="button" disabled={!canImport} onClick={() => void importSelected()}>
            {busy ? '处理中…' : `导入所选（${selected.size}）`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
