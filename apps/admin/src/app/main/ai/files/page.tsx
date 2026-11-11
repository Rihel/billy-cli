'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { formatFileSize } from '@repo/shared/browser'
import type { AgentFileAdminItem } from '@repo/shared'
import {
  Badge,
  Button,
  DataTable,
  DateRangePicker,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DisplayValue,
  FilePreview,
  Input,
  Markdown,
  RefreshButton,
  useStorageAdapter,
  toastError,
} from '@repo/ui'
import type { DataTableColumnDef, DateRangeValue } from '@repo/ui'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  EyeIcon,
  SearchIcon,
} from 'lucide-react'
import { SandboxFrame } from '@repo/ui/components/ai-elements/markdown-fences/sandbox-frame.tsx'
import { useServerClient } from '@/lib/server-client'

/**
 * AI 文件管理（`/main/ai/files`，管理员）。
 *
 * 全量 `ai_files` 视角：不按会话进入，先看“所有文件分别属于谁”；
 * 指标卡在控制台 dashboard，本页只保留筛选、明细与预览 / 下载。
 */
const PAGE_SIZE = 20

const formatBytes = (bytes: number): string => formatFileSize(bytes)

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml',
  'html', 'htm', 'log', 'sql', 'ini', 'conf', 'toml', 'properties', 'sh', 'bash',
  'py', 'ts', 'tsx', 'js', 'jsx', 'java', 'go', 'rs', 'rb', 'php', 'c', 'h',
  'cpp', 'hpp', 'css', 'scss', 'less', 'vue', 'svelte', 'graphql', 'gql',
])

const extOf = (filename: string): string => {
  const base = filename.split('/').pop() ?? filename
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

const isTextPreview = (file: AgentFileAdminItem): boolean =>
  file.mediaType.startsWith('text/') ||
  ['application/json', 'application/xml', 'application/yaml', 'application/x-yaml',
    'application/javascript', 'application/typescript', 'application/sql'].includes(file.mediaType) ||
  TEXT_EXTENSIONS.has(extOf(file.filename))

const isHtml = (file: AgentFileAdminItem): boolean =>
  file.mediaType === 'text/html' || ['html', 'htm'].includes(extOf(file.filename))

const isMarkdown = (file: AgentFileAdminItem): boolean =>
  file.mediaType === 'text/markdown' || ['md', 'markdown'].includes(extOf(file.filename))

export default function AiFilesPage() {
  const client = useServerClient()
  const { resolveUrl } = useStorageAdapter()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [range, setRange] = useState<DateRangeValue>({})
  const [sortBy, setSortBy] = useState<'size' | 'createdAt'>('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [preview, setPreview] = useState<AgentFileAdminItem | null>(null)

  const filters = {
    keyword,
    from: range.from,
    to: range.to,
  }

  const filesQuery = useQuery({
    queryKey: [
      'ai',
      'file',
      'admin',
      'list',
      { page, pageSize, keyword, from: range.from, to: range.to, sortBy, sortOrder },
    ],
    queryFn: () =>
      client.agent.file.adminList({
        page,
        size: pageSize,
        ...filters,
        sortBy,
        sortOrder,
      }),
  })

  const textQuery = useQuery({
    queryKey: ['ai', 'file', 'admin', 'preview', preview?.id ?? 'none'],
    queryFn: () => client.agent.file.adminPreview({ fileId: preview!.id }),
    enabled: Boolean(preview && isTextPreview(preview)),
  })

  const files = filesQuery.data?.items ?? []

  const applyKeyword = () => {
    setKeyword(searchText.trim() || undefined)
    setPage(1)
  }

  const refresh = () => {
    void filesQuery.refetch()
  }

  const download = async (file: AgentFileAdminItem) => {
    try {
      const { url } = await client.storage.getDownloadUrl({
        key: file.key,
        filename: file.filename,
      })
      window.location.href = url
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleSizeSort = () => {
    if (sortBy === 'size') {
      setSortOrder((current) => (current === 'desc' ? 'asc' : 'desc'))
    } else {
      // 第一次点「大小」默认降序（先看最大的），再点切升序
      setSortBy('size')
      setSortOrder('desc')
    }
    setPage(1)
  }

  const columns: DataTableColumnDef<AgentFileAdminItem>[] = [
    {
      header: '文件',
      accessorKey: 'filename',
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">{row.original.filename}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.original.path}
          </span>
        </div>
      ),
    },
    {
      header: '所属会话',
      accessorKey: 'conversationTitle',
      meta: { width: 220 },
      cell: ({ row }) => (
        <Link
          href={`/main/ai/chat/${row.original.conversationId}`}
          className="flex min-w-0 flex-col gap-0.5 hover:text-primary"
        >
          <span className="truncate">{row.original.conversationTitle || '(无标题会话)'}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {row.original.conversationId}
          </span>
        </Link>
      ),
    },
    {
      header: '来源',
      accessorKey: 'source',
      meta: { width: 100 },
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.source === 'user' ? '用户上传' : 'AI 生成'}
        </Badge>
      ),
    },
    {
      header: '大小',
      accessorKey: 'bytes',
      meta: { width: 110 },
      cell: ({ row }) => (
        <span className="font-mono text-xs tabular-nums">{formatBytes(row.original.bytes)}</span>
      ),
    },
    {
      header: '创建时间',
      accessorKey: 'createdAt',
      meta: { width: 170 },
      cell: ({ row }) => (
        <DisplayValue
          type="date"
          value={row.original.createdAt}
          className="text-xs text-muted-foreground"
        />
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 150 },
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreview(row.original)}
            title="预览文件"
          >
            <EyeIcon className="size-3.5" />
            预览
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void download(row.original)}
            title="下载文件"
          >
            <DownloadIcon className="size-3.5" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AgentFileAdminItem>
        title="AI 文件管理"
        description="所有会话的文件汇总；关键字匹配文件名 / 会话名，时间范围按文件创建时间筛选"
        columns={columns}
        data={files}
        loading={filesQuery.isFetching}
        rowKey="id"
        page={page}
        pageSize={pageSize}
        total={filesQuery.data?.total}
        pageSizeOptions={[10, 20, 50, 100]}
        onPageChange={(nextPage, nextSize) => {
          setPage(nextPage)
          setPageSize(nextSize)
        }}
        emptyText="没有匹配的文件：换个关键字或时间范围"
        toolbar={
          <>
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="文件名 / 会话名..."
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.target.value)
                  if (event.target.value === '') {
                    setKeyword(undefined)
                    setPage(1)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyKeyword()
                }}
                className="h-7 w-44 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button size="sm" variant="outline" onClick={applyKeyword}>
              搜索
            </Button>
            <DateRangePicker
              value={range}
              onChange={(next) => {
                setRange(next)
                setPage(1)
              }}
              className="h-7"
            />
            <Button
              variant={sortBy === 'size' ? 'secondary' : 'outline'}
              size="sm"
              onClick={toggleSizeSort}
              title="按文件大小排序"
            >
              {sortBy === 'size' && sortOrder === 'asc' ? (
                <ArrowUpIcon className="size-3.5" />
              ) : (
                <ArrowDownIcon className="size-3.5" />
              )}
              大小{sortBy === 'size' ? (sortOrder === 'asc' ? '升序' : '降序') : '排序'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setKeyword(undefined)
                setSearchText('')
                setRange({})
                setSortBy('createdAt')
                setSortOrder('desc')
                setPage(1)
              }}
            >
              重置
            </Button>
            <RefreshButton onClick={refresh} />
          </>
        }
      />

      <PreviewDialog
        target={preview}
        url={preview ? resolveUrl(preview.key) : null}
        text={textQuery.data?.text ?? null}
        loading={textQuery.isLoading}
        onClose={() => setPreview(null)}
        onDownload={(file) => void download(file)}
      />
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center px-6 text-center text-xs text-muted-foreground">
      {text}
    </div>
  )
}

function PreviewDialog({
  target,
  url,
  text,
  loading,
  onClose,
  onDownload,
}: {
  target: AgentFileAdminItem | null
  url: string | null
  text: string | null
  loading: boolean
  onClose: () => void
  onDownload: (file: AgentFileAdminItem) => void
}) {
  if (!target) return null
  const html = isHtml(target)
  const markdown = isMarkdown(target)
  const isText = isTextPreview(target)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        bodyScroll={false}
        className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 rounded-none p-0 sm:max-w-none"
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-14">
          <DialogTitle className="truncate text-sm">{target.filename}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {html ? (
            loading ? (
              <Empty text="正在读取…" />
            ) : (
              <SandboxFrame
                html={text ?? ''}
                title={target.filename}
                language="html"
                minHeight={600}
                maxHeight={1000}
              />
            )
          ) : isText ? (
            loading ? (
              <Empty text="正在读取…" />
            ) : markdown ? (
              <Markdown content={text ?? ''} />
            ) : (
              <pre className="whitespace-pre-wrap break-words text-xs">{text ?? ''}</pre>
            )
          ) : url ? (
            <FilePreview
              file={{
                key: url,
                name: target.filename,
                type: target.mediaType,
                size: target.bytes,
              }}
              height="100%"
            />
          ) : (
            <Empty text="当前类型不支持在线预览，请下载查看。" />
          )}
        </div>
        <div className="flex shrink-0 justify-end gap-2 border-t px-4 py-3">
          <Button variant="outline" size="sm" onClick={() => onDownload(target)}>
            <DownloadIcon className="size-3.5" />
            下载
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
