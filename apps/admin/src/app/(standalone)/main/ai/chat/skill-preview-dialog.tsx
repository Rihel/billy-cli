'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Markdown,
} from '@repo/ui'
import { ExternalLinkIcon, FileCode2Icon, FileTextIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { stripFrontmatter } from '@/lib/skill-markdown'
import { CodeEditor } from '@/components/skills/code-editor'
import type { SkillWriteDraft } from './skill-tool'

/**
 * 技能**只读预览弹窗**：用 editor 页那套「左文件树 + 右文档画布」的版面，
 * 但整棵都是只读的 —— 看 AI 写了什么、切换文件看 references / scripts，不在这里改。
 *
 * 数据两条源（与编辑器一致的口径）：
 * 1. 库（`aiSkill.detail` + `file/read`）是权威版本；
 * 2. `skill-save` 的草稿（入参里的正文 / 文件）用于"还没落库 / 落库失败"时先看。
 *
 * `SKILL.md` 展示前 strip frontmatter（YAML 交给 Markdown 会被解析成 setext 标题）；
 * 名字 / 描述 / 版本在头部与底部单独展示。
 */
export function SkillPreviewDialog(props: SkillPreviewDialogProps) {
  // 关闭时不挂载：避免每张工具卡 / 每个技能卡常驻一个查询观察者
  if (!props.open) return null
  return <SkillPreviewDialogBody {...props} />
}

interface SkillPreviewDialogProps {
  open: boolean
  skillKey: string
  draft?: SkillWriteDraft
  source?: string
  onOpenChange: (open: boolean) => void
}

const GROUPS = ['references', 'scripts', 'assets'] as const

const groupOf = (path: string): string | null => {
  const [head] = path.split('/')
  return (GROUPS as readonly string[]).includes(head ?? '') ? (head as string) : null
}

function SkillPreviewDialogBody({
  open,
  skillKey,
  draft,
  source,
  onOpenChange,
}: SkillPreviewDialogProps) {
  const client = useServerClient()
  const [path, setPath] = useState('SKILL.md')

  useEffect(() => {
    if (open) setPath('SKILL.md')
  }, [open, skillKey])

  const detailQuery = useQuery({
    queryKey: ['ai', 'skill-detail', skillKey],
    queryFn: () => client.aiSkill.detail({ skillKey }),
    enabled: open && Boolean(skillKey),
    retry: false,
  })
  const detail = detailQuery.data

  const fileQuery = useQuery({
    queryKey: ['ai', 'skill-file', skillKey, path],
    queryFn: () => client.aiSkill.readFile({ skillKey, path }),
    enabled: open && Boolean(detail) && Boolean(path),
    retry: false,
  })

  const files = useMemo(() => {
    if (detail) return detail.files.map((file) => ({ path: file.path, kind: file.kind }))
    if (!draft) return []
    return [
      { path: 'SKILL.md', kind: 'markdown' },
      ...draft.files.map((file) => ({
        path: file.path,
        kind: file.path.toLowerCase().endsWith('.md') ? 'markdown' : 'code',
      })),
    ]
  }, [detail, draft])

  useEffect(() => {
    if (files.length > 0 && !files.some((file) => file.path === path)) setPath('SKILL.md')
  }, [files, path])

  const draftContent =
    path === 'SKILL.md' ? draft?.body : draft?.files.find((file) => file.path === path)?.content
  const raw = fileQuery.data?.content ?? draftContent ?? ''
  const isMarkdown = path.toLowerCase().endsWith('.md')
  const display = path === 'SKILL.md' && fileQuery.data ? stripFrontmatter(raw) : raw
  const description = detail?.description ?? draft?.description ?? ''
  const loading = detailQuery.isLoading || (Boolean(detail) && fileQuery.isLoading && !draftContent)
  const entry = files.find((file) => file.path === 'SKILL.md')
  const groups = GROUPS.map((group) => ({
    group,
    files: files.filter((file) => groupOf(file.path) === group),
  })).filter((item) => item.files.length > 0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        bodyScroll={false}
        className="max-w-none gap-0 overflow-hidden p-0 sm:max-w-none"
        style={{ width: 'min(1120px, 94vw)', height: '86vh' }}
      >
        <DialogHeader className="shrink-0 border-b border-border/60 px-5 py-3 pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle className="font-mono text-sm">{skillKey}</DialogTitle>
            {detail ? (
              detail.enabled ? (
                <Badge variant="secondary">已启用</Badge>
              ) : (
                <Badge variant="outline">已停用</Badge>
              )
            ) : draft ? (
              <Badge variant="outline">尚未落库</Badge>
            ) : null}
            {source ? <Badge variant="outline">{source}</Badge> : null}
          </div>
          <DialogDescription className="line-clamp-2 text-xs leading-5">
            {description || '（没有描述）'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* 左：文件树（与编辑器同构，但没有新增 / 删除） */}
          <aside className="hidden w-[220px] shrink-0 flex-col border-r border-border/60 bg-surface-1/40 sm:flex">
            <div className="px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              文件
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
              {entry ? (
                <FileRow file={entry} active={path === entry.path} onSelect={setPath} />
              ) : null}
              {groups.map(({ group, files: groupFiles }) => (
                <div key={group} className="mt-2 flex flex-col gap-0.5">
                  <p className="px-2 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                    {group}
                  </p>
                  {groupFiles.map((file) => (
                    <FileRow
                      key={file.path}
                      file={file}
                      active={path === file.path}
                      onSelect={setPath}
                    />
                  ))}
                </div>
              ))}
            </div>
            <div className="border-t border-border/60 px-3 py-2 text-[10px] text-muted-foreground">
              只读预览
            </div>
          </aside>

          {/* 右：文档画布 */}
          <main className="min-w-0 flex-1 overflow-auto bg-card">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8 sm:px-10">
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                {isMarkdown ? (
                  <FileTextIcon className="size-3.5" />
                ) : (
                  <FileCode2Icon className="size-3.5" />
                )}
                <span className="font-mono">{path}</span>
              </div>

              {detailQuery.isError && !draft ? (
                <p className="text-xs text-destructive">
                  技能读取失败（可能还没落库 / 已删除 / 来自外部目录）。
                </p>
              ) : loading ? (
                <p className="text-xs text-muted-foreground">正在读取…</p>
              ) : !raw.trim() ? (
                <p className="text-xs text-muted-foreground">这个文件还是空的。</p>
              ) : isMarkdown ? (
                <div className="text-[15px] leading-7">
                  <Markdown content={display} />
                </div>
              ) : (
                <CodeEditor
                  key={path}
                  filename={path}
                  initialContent={raw}
                  readOnly
                  onChange={() => undefined}
                />
              )}
            </div>
          </main>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border/60 px-5 py-2.5">
          <span className="text-[11px] text-muted-foreground">
            {detail
              ? `v${detail.version} · ${detail.fileCount} 个文件`
              : draft
                ? `${1 + draft.files.length} 个文件（草稿）`
                : ''}
          </span>
          {detail ? (
            <a
              href={`/main/ai/skills/${encodeURIComponent(skillKey)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] text-info underline-offset-2 hover:underline"
            >
              在编辑器中打开
              <ExternalLinkIcon className="size-3" />
            </a>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FileRow({
  file,
  active,
  onSelect,
}: {
  file: { path: string; kind: string }
  active: boolean
  onSelect: (path: string) => void
}) {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <button
      type="button"
      className={`flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left ${
        active ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-1/60'
      }`}
      onClick={() => onSelect(file.path)}
    >
      {file.kind === 'markdown' ? (
        <FileTextIcon className="size-3.5 shrink-0 opacity-70" />
      ) : (
        <FileCode2Icon className="size-3.5 shrink-0 opacity-70" />
      )}
      <span className="truncate font-mono text-[11px]">{name}</span>
    </button>
  )
}
