'use client'

import dynamic from 'next/dynamic'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SKILL_DESCRIPTION_PLACEHOLDER, SKILL_FILE_PATH_PATTERN, SkillSource } from '@repo/shared'
import type { AiSkillDetailModel, AiSkillFileModel } from '@repo/shared'
import {
  Alert,
  AlertDescription,
  Button,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DictTag,
  Input,
  Label,
  Switch,
  toastError,
  toastSuccess,
} from '@repo/ui'
import {
  ArrowLeftIcon,
  CheckIcon,
  FileCode2Icon,
  FileTextIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { stripFrontmatter } from '@/lib/skill-markdown'
import { CodeEditor } from '@/components/skills/code-editor'
import type { NotionEditorHandle } from '@/components/skills/notion-editor'

/**
 * **沉浸式技能编辑器**（全窗口画布）。
 *
 * 版面刻意"像写文档"而不是"像后台表单"：
 * - 没有侧边管理菜单 / 页头，只有一条 44px 的工具条；
 * - 正文是一张居中的 860px 画布：大标题 + 一句"何时用" + 一条分隔线 + 块编辑器；
 * - 文件树收在左侧一条窄栏里（参考文件 / 脚本），不抢正文的注意力；
 * - 脏了才在底部浮出「保存 · ⌘S」，像 Notion 的保存提示，而不是常驻按钮堆。
 *
 * 数据口径不变：`SKILL.md` 的 frontmatter 用画布顶部的标题 / 描述与"高级设置"维护，
 * 块编辑器只写正文；保存时先存元信息（若有改动）再存文件，乐观锁冲突如实提示。
 */
const NotionEditor = dynamic(
  () => import('@/components/skills/notion-editor').then((module) => module.NotionEditor),
  {
    ssr: false,
    loading: () => (
      <div className="py-16 text-center text-sm text-muted-foreground">正在准备编辑器…</div>
    ),
  },
)

const GROUPS = ['references', 'scripts', 'assets'] as const
type Group = (typeof GROUPS)[number]

const groupOf = (path: string): Group | null => {
  const [head] = path.split('/')
  return (GROUPS as readonly string[]).includes(head ?? '') ? (head as Group) : null
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

export function SkillEditor({ skillKey }: { skillKey: string }) {
  const client = useServerClient()
  const router = useRouter()
  const queryClient = useQueryClient()

  const detailQuery = useQuery({
    queryKey: ['aiSkill', 'detail', skillKey],
    queryFn: () => client.aiSkill.detail({ skillKey }),
  })
  const detail = detailQuery.data

  const [activePath, setActivePath] = useState('SKILL.md')
  const [fileDirty, setFileDirty] = useState(false)
  const [codeDraft, setCodeDraft] = useState('')
  const editorRef = useRef<NotionEditorHandle>(null)

  const fileQuery = useQuery({
    queryKey: ['aiSkill', 'file', skillKey, activePath],
    queryFn: () => client.aiSkill.readFile({ skillKey, path: activePath }),
    enabled: Boolean(detail) && Boolean(activePath),
  })

  // 元信息只在首次拿到详情时初始化（后台刷新不冲掉正在输入的内容）
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [frontmatterJson, setFrontmatterJson] = useState('{}')
  const initializedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!detail || initializedFor.current === detail.skillKey) return
    initializedFor.current = detail.skillKey
    setTitle(detail.title)
    // 占位描述不当作"已填写"：输入框留空，只显示 placeholder 与下方提示
    setDescription(detail.description === SKILL_DESCRIPTION_PLACEHOLDER ? '' : detail.description)
    setFrontmatterJson(JSON.stringify(detail.frontmatter ?? {}, null, 2))
  }, [detail])

  // 切文件：清脏标记，用新内容初始化代码编辑器
  useEffect(() => {
    setFileDirty(false)
    setCodeDraft(fileQuery.data?.content ?? '')
  }, [activePath, fileQuery.data])

  const invalidate = useCallback(
    async (options: { files?: boolean } = {}): Promise<void> => {
      await queryClient.invalidateQueries({ queryKey: ['aiSkill', 'detail', skillKey] })
      if (options.files) {
        await queryClient.invalidateQueries({ queryKey: ['aiSkill', 'file', skillKey] })
      }
      await queryClient.invalidateQueries({ queryKey: ['aiSkill', 'list'] })
    },
    [queryClient, skillKey],
  )

  const updateMutation = useMutation({
    mutationFn: (input: Parameters<typeof client.aiSkill.update>[0]) =>
      client.aiSkill.update(input),
  })
  const saveFileMutation = useMutation({
    mutationFn: (input: Parameters<typeof client.aiSkill.saveFile>[0]) =>
      client.aiSkill.saveFile(input),
  })
  const removeFileMutation = useMutation({
    mutationFn: (path: string) => client.aiSkill.removeFile({ skillKey, path }),
  })
  const removeSkillMutation = useMutation({
    mutationFn: () => client.aiSkill.remove({ skillKey }),
  })

  const storedDescription =
    detail?.description === SKILL_DESCRIPTION_PLACEHOLDER ? '' : (detail?.description ?? '')
  const metaDirty =
    Boolean(detail) &&
    (title !== detail!.title ||
      description !== storedDescription ||
      frontmatterJson !== JSON.stringify(detail!.frontmatter ?? {}, null, 2))
  const dirty = metaDirty || fileDirty
  const saving =
    updateMutation.isPending || saveFileMutation.isPending || removeFileMutation.isPending

  /** 一次保存：元信息（有改动）+ 当前文件（有改动），共用同一条版本链 */
  const saveAll = useCallback(async (): Promise<void> => {
    if (!detail || !dirty || saving) return

    let parsedFrontmatter: Record<string, unknown> = detail.frontmatter ?? {}
    if (metaDirty) {
      try {
        const value = JSON.parse(frontmatterJson || '{}') as unknown
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('必须是 JSON 对象')
        }
        parsedFrontmatter = value as Record<string, unknown>
      } catch (error) {
        toastError(`frontmatter 不是合法的 JSON 对象：${messageOf(error)}`)
        return
      }
    }

    try {
      let version = detail.version
      if (metaDirty) {
        const next = await updateMutation.mutateAsync({
          skillKey,
          title: title.trim() || skillKey,
          // 还没补描述时保留占位（Mastra 不允许空 description），不拦着先存正文
          description: description.trim() || SKILL_DESCRIPTION_PLACEHOLDER,
          frontmatter: parsedFrontmatter,
          expectedVersion: version,
        })
        version = next.version
        setTitle(next.title)
        setDescription(next.description === SKILL_DESCRIPTION_PLACEHOLDER ? '' : next.description)
        setFrontmatterJson(JSON.stringify(next.frontmatter ?? {}, null, 2))
      }
      if (fileDirty) {
        const content = activePath.toLowerCase().endsWith('.md')
          ? (editorRef.current?.getMarkdown() ?? '')
          : codeDraft
        await saveFileMutation.mutateAsync({
          skillKey,
          path: activePath,
          content,
          expectedVersion: version,
        })
        setFileDirty(false)
      }
      toastSuccess('已保存', '落盘完成，模型下一轮可见')
      await invalidate({ files: true })
    } catch (error) {
      toastError(messageOf(error))
    }
  }, [
    activePath,
    codeDraft,
    description,
    detail,
    dirty,
    fileDirty,
    frontmatterJson,
    invalidate,
    metaDirty,
    saving,
    saveFileMutation,
    skillKey,
    title,
    updateMutation,
  ])

  // ⌘S / Ctrl+S 保存；有未保存内容时离开页面先拦一下
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveAll()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [saveAll])

  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirty])

  const toggleEnabled = async (enabled: boolean): Promise<void> => {
    try {
      await updateMutation.mutateAsync({ skillKey, enabled })
      toastSuccess(enabled ? '已启用' : '已停用', enabled ? '已落盘，模型可见' : '已移出落盘目录')
      await invalidate()
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const addFile = async (path: string): Promise<void> => {
    try {
      await saveFileMutation.mutateAsync({
        skillKey,
        path,
        content: '',
        expectedVersion: detail?.version,
      })
      setActivePath(path)
      toastSuccess(`已新建 ${path}`)
      await invalidate({ files: true })
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const removeFile = async (path: string): Promise<void> => {
    try {
      await removeFileMutation.mutateAsync(path)
      if (activePath === path) setActivePath('SKILL.md')
      toastSuccess(`已删除 ${path}`)
      await invalidate({ files: true })
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const removeSkill = async (): Promise<void> => {
    try {
      await removeSkillMutation.mutateAsync()
      toastSuccess(`已删除技能「${skillKey}」`)
      router.push('/main/ai/skills')
    } catch (error) {
      toastError(messageOf(error))
    }
  }

  const [settingsOpen, setSettingsOpen] = useState(false)

  if (detailQuery.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        正在打开技能…
      </div>
    )
  }
  if (detailQuery.isError || !detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-sm text-destructive">
          技能加载失败：{messageOf(detailQuery.error) || '不存在或无权访问'}
        </p>
        <Button variant="outline" onClick={() => router.push('/main/ai/skills')}>
          返回技能库
        </Button>
      </div>
    )
  }

  const activeIsMarkdown = activePath.toLowerCase().endsWith('.md')
  const activeFile = detail.files.find((file) => file.path === activePath)
  const needsDescription = description.trim() === ''
  // SKILL.md 的编辑器只看正文；参考文件原样展示
  const editorMarkdown =
    activePath === 'SKILL.md'
      ? stripFrontmatter(fileQuery.data?.content ?? '')
      : (fileQuery.data?.content ?? '')

  return (
    <div className="flex h-full flex-col bg-card">
      {/* 顶部工具条：只保留"我在哪 / 存 / 开关 / 设置" */}
      <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border/50 bg-card px-2.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="返回技能库"
          onClick={() => router.push('/main/ai/skills')}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="ml-1 flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium">{detail.skillKey}</span>
          <DictTag dict={SkillSource} value={detail.source} emptyText={detail.source} />
          {detail.originUrl ? (
            <a
              className="max-w-[320px] truncate text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              href={detail.originUrl}
              target="_blank"
              rel="noreferrer"
            >
              {detail.originUrl}
            </a>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {dirty ? '未保存' : '已保存'}
          </span>
          <Label className="gap-1.5 text-[11px] font-normal text-muted-foreground">
            <Switch
              checked={detail.enabled}
              disabled={saving}
              aria-label="启用状态"
              onCheckedChange={(checked) => void toggleEnabled(checked === true)}
            />
            {detail.enabled ? '已启用' : '已停用'}
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="技能设置"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2Icon />
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void saveAll()}
          >
            保存
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 文件窄栏：不抢正文注意力 */}
        <aside className="hidden w-[210px] shrink-0 flex-col border-r border-border/50 bg-surface-1/50 md:flex">
          <div className="flex items-center justify-between px-3 pb-1 pt-4">
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground">
              文件
            </span>
            <AddFileButton disabled={saving} onAdd={addFile} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-4">
            <FileRail
              files={detail.files}
              activePath={activePath}
              saving={saving}
              onSelect={setActivePath}
              onRemove={removeFile}
            />
          </div>
          <div className="flex flex-col gap-1 border-t border-border/50 px-3 py-2.5 text-[10px] leading-4 text-muted-foreground">
            {detail.files.length <= 1 ? (
              <span>参考文档放 references/，脚本放 scripts/。</span>
            ) : null}
            <span>
              v{detail.version} · {detail.files.length} 个文件
            </span>
          </div>
        </aside>

        {/* 正文画布 */}
        <main className="relative min-w-0 flex-1 overflow-auto bg-card">
          <div className="mx-auto flex w-full max-w-[860px] flex-col px-6 pb-52 pt-12 sm:px-10 sm:pt-16">
            {activePath === 'SKILL.md' ? (
              <>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="技能标题"
                  className="w-full border-0 bg-transparent text-[34px] font-semibold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/35"
                />
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={2}
                  placeholder="写清楚：什么场景下该用这个技能（模型据此决定是否激活）"
                  className="mt-4 w-full resize-none border-0 bg-transparent text-[15px] leading-7 text-muted-foreground outline-none placeholder:text-muted-foreground/40"
                />
                {needsDescription ? (
                  <p className="mt-1 text-[11px] text-warning">
                    描述还是占位文案 —— 补一句"什么时候用"，模型才敢激活它。
                  </p>
                ) : null}
                <div className="my-9 h-px w-full bg-border/50" />
              </>
            ) : (
              <div className="mb-6 flex items-center gap-2 text-[11px] text-muted-foreground">
                <FileCode2Icon className="size-3.5" />
                <span className="font-mono">{activePath}</span>
                {activeFile ? <span>· {formatSize(activeFile.size)}</span> : null}
              </div>
            )}

            {detail.warnings.length > 0 && activePath === 'SKILL.md' ? (
              <Alert className="mb-6">
                <AlertDescription>
                  <ul className="list-disc pl-4 text-[11px]">
                    {detail.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}

            {fileQuery.isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">正在加载文件…</div>
            ) : activeIsMarkdown ? (
              <div className="skill-canvas">
                <NotionEditor
                  key={activePath}
                  ref={editorRef}
                  initialMarkdown={editorMarkdown}
                  placeholder={
                    activePath === 'SKILL.md'
                      ? '写清楚：做什么、按什么步骤做、边界在哪（输入 / 唤起命令）'
                      : '写这个参考文件的内容…'
                  }
                  onChange={() => setFileDirty(true)}
                />
              </div>
            ) : (
              <CodeEditor
                key={activePath}
                filename={activePath}
                initialContent={fileQuery.data?.content ?? ''}
                onChange={(content) => {
                  setCodeDraft(content)
                  setFileDirty(true)
                }}
              />
            )}
          </div>

          {/* 底部浮层：脏了才出现（Notion 式保存提示） */}
          {dirty ? (
            <div className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center">
              <button
                type="button"
                onClick={() => void saveAll()}
                disabled={saving}
                className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-popover px-4 py-2 text-xs shadow-lg transition hover:bg-surface-2 disabled:opacity-60"
              >
                {saving ? (
                  '保存中…'
                ) : (
                  <>
                    <CheckIcon className="size-3.5" />
                    保存修改
                    <kbd className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      ⌘S
                    </kbd>
                  </>
                )}
              </button>
            </div>
          ) : null}
        </main>
      </div>

      <SkillSettingsDialog
        open={settingsOpen}
        detail={detail}
        skillKey={skillKey}
        removing={removeSkillMutation.isPending}
        onClose={() => setSettingsOpen(false)}
        onRemove={removeSkill}
      />
    </div>
  )
}

// ─────────────────────────── 文件栏 ───────────────────────────

function FileRail({
  files,
  activePath,
  saving,
  onSelect,
  onRemove,
}: {
  files: readonly AiSkillFileModel[]
  activePath: string
  saving: boolean
  onSelect: (path: string) => void
  onRemove: (path: string) => Promise<void>
}) {
  const entry = files.find((file) => file.path === 'SKILL.md')
  const groups = GROUPS.map((group) => ({
    group,
    files: files.filter((file) => groupOf(file.path) === group),
  })).filter((item) => item.files.length > 0)

  return (
    <div className="flex flex-col gap-0.5">
      {entry ? (
        <FileRow
          file={entry}
          active={activePath === entry.path}
          removable={false}
          saving={saving}
          onSelect={onSelect}
          onRemove={onRemove}
        />
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
              active={activePath === file.path}
              removable
              saving={saving}
              onSelect={onSelect}
              onRemove={onRemove}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function FileRow({
  file,
  active,
  removable,
  saving,
  onSelect,
  onRemove,
}: {
  file: AiSkillFileModel
  active: boolean
  removable: boolean
  saving: boolean
  onSelect: (path: string) => void
  onRemove: (path: string) => Promise<void>
}) {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <div
      className={`group flex items-center rounded-md pr-1 ${
        active ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:bg-surface-1/60'
      }`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
        onClick={() => onSelect(file.path)}
      >
        {file.kind === 'markdown' ? (
          <FileTextIcon className="size-3.5 shrink-0 opacity-70" />
        ) : (
          <FileCode2Icon className="size-3.5 shrink-0 opacity-70" />
        )}
        <span className="truncate font-mono text-[11px]">{name}</span>
      </button>
      {removable ? (
        <span className="opacity-0 transition group-hover:opacity-100">
          <ConfirmAction
            title={`确认删除 ${file.path}？`}
            description="删除后落盘目录里的这个文件也会被移除。"
            danger
            okText="删除"
            disabled={saving}
            onConfirm={() => onRemove(file.path)}
          >
            <Trash2Icon className="size-3" />
          </ConfirmAction>
        </span>
      ) : null}
    </div>
  )
}

// ─────────────────────────── 新建文件 ───────────────────────────

function AddFileButton({
  disabled,
  onAdd,
}: {
  disabled: boolean
  onAdd: (path: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [group, setGroup] = useState<Group>('references')
  const [name, setName] = useState('')

  const path = name.trim() ? `${group}/${name.trim()}` : ''
  const valid = Boolean(path) && SKILL_FILE_PATH_PATTERN.test(path)

  const submit = async (): Promise<void> => {
    if (!valid) return
    await onAdd(path)
    setOpen(false)
    setName('')
  }

  return (
    <>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="新建文件"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <PlusIcon />
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next ? undefined : setOpen(false))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建技能文件</DialogTitle>
            <DialogDescription>
              参考文档放 <code>references/</code>，可执行脚本放 <code>scripts/</code>。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex gap-2">
              {GROUPS.map((item) => (
                <Button
                  key={item}
                  type="button"
                  size="sm"
                  variant={group === item ? 'default' : 'outline'}
                  onClick={() => setGroup(item)}
                >
                  {item}/
                </Button>
              ))}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-file-name" className="text-xs">
                文件名
              </Label>
              <Input
                id="new-file-name"
                value={name}
                placeholder="例如 checklist.md"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit()
                }}
              />
              <p className="text-[11px] text-muted-foreground">
                完整路径：<code>{path || `${group}/…`}</code>
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" disabled={!valid} onClick={() => void submit()}>
              新建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ─────────────────────────── 设置 ───────────────────────────

function SkillSettingsDialog({
  open,
  detail,
  skillKey,
  removing,
  onClose,
  onRemove,
}: {
  open: boolean
  detail: AiSkillDetailModel
  skillKey: string
  removing: boolean
  onClose: () => void
  onRemove: () => Promise<void>
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>技能设置</DialogTitle>
          <DialogDescription>
            来源、版本与删除；frontmatter 的其他字段在正文上方编辑。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">技能名</span>
            <span className="font-mono">{skillKey}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">来源</span>
            <span className="max-w-[320px] truncate">{detail.originUrl ?? '在线创建'}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">版本</span>
            <span>v{detail.version}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">文件</span>
            <span>{detail.fileCount} 个</span>
          </div>
          <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-[11px] text-muted-foreground">
              删除会同时移除落盘目录，模型立刻看不到它；历史运行里的技能名不会再对应到任何技能。
            </p>
            <div className="mt-2">
              <ConfirmAction
                title={`确认删除技能「${skillKey}」？`}
                description="删除后不可恢复（软删 + 删落盘目录）。只是暂时不用请直接关掉启用开关。"
                danger
                okText="删除技能"
                disabled={removing}
                onConfirm={onRemove}
              >
                <Trash2Icon className="size-3.5" />
                删除技能
              </ConfirmAction>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
