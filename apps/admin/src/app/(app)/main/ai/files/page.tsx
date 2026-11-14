'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { formatFileSize } from '@repo/shared/browser'
import type { AgentFileAdminItem } from '@repo/shared'
import {
  Badge,
  Button,
  DataTable,
  DateRangePicker,
  DisplayValue,
  Input,
  RefreshButton,
  toastError,
} from '@repo/ui'
import type { DataTableColumnDef, DateRangeValue } from '@repo/ui'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  EyeIcon,
  SearchIcon,
  Share2Icon,
} from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { FilePreviewDialog, isPreviewTextItem, officeKind } from '@/components/file-preview-dialog'
import { ShareDialog, type ShareDialogFile } from '@/components/share-dialog'

/**
 * AI 文件管理（`/main/ai/files`，管理员）。
 *
 * 全量 `ai_files` 视角：不按会话进入，先看“所有文件分别属于谁”；
 * 指标卡在控制台 dashboard，本页只保留筛选、明细与预览 / 下载。
 */
const PAGE_SIZE = 20

const formatBytes = (bytes: number): string => formatFileSize(bytes)

export default function AiFilesPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [range, setRange] = useState<DateRangeValue>({})
  const [sortBy, setSortBy] = useState<'size' | 'createdAt'>('createdAt')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [shareFile, setShareFile] = useState<ShareDialogFile | null>(null)

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

  // 稳定引用：查询未返回时不能每次渲染都造一个新数组，否则 previewItems 每帧重算
  const files = useMemo(() => filesQuery.data?.items ?? [], [filesQuery.data?.items])

  const previewItems = useMemo(
    () =>
      files.map((file) => ({
        id: file.id,
        filename: file.filename,
        subtitle: file.conversationTitle || undefined,
        badge: file.source === 'user' ? '用户上传' : 'AI 生成',
        mediaType: file.mediaType,
        bytes: file.bytes,
        // 桶私有：预览地址按需签短时预签名（文本走 textQuery，Office 走 loadBytes）
        url: null,
        loadUrl:
          isPreviewTextItem(file) || officeKind(file)
            ? undefined
            : async () => {
                const { url } = await client.storage.getDownloadUrl({
                  key: file.key,
                  filename: file.filename,
                })
                return url
              },
        loadBytes: officeKind(file)
          ? async () => {
              const { url } = await client.storage.getDownloadUrl({
                key: file.key,
                filename: file.filename,
              })
              const response = await fetch(url)
              if (!response.ok) throw new Error(`对象存储读取失败（HTTP ${response.status}）`)
              return response.arrayBuffer()
            }
          : undefined,
      })),
    [files, client],
  )
  const previewIndex = previewId ? previewItems.findIndex((item) => item.id === previewId) : -1
  const previewItem = previewIndex >= 0 ? previewItems[previewIndex] : null

  const textQuery = useQuery({
    queryKey: ['ai', 'file', 'admin', 'preview', previewItem?.id ?? 'none'],
    queryFn: () => client.agent.file.adminPreview({ fileId: previewItem!.id }),
    enabled: Boolean(previewItem && isPreviewTextItem(previewItem)),
  })

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
        <Badge variant="outline">{row.original.source === 'user' ? '用户上传' : 'AI 生成'}</Badge>
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
            onClick={() => setPreviewId(row.original.id)}
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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setShareFile({ id: row.original.id, filename: row.original.filename })}
            title="生成免授权分享链接（任何人拿到都能看）"
          >
            <Share2Icon className="size-3.5" />
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

      <ShareDialog file={shareFile} open={Boolean(shareFile)} onClose={() => setShareFile(null)} />

      <FilePreviewDialog
        items={previewItems}
        index={previewIndex >= 0 ? previewIndex : null}
        onIndexChange={(next) => setPreviewId(previewItems[next]?.id ?? null)}
        onClose={() => setPreviewId(null)}
        onDownload={(item) => {
          const file = files.find((candidate) => candidate.id === item.id)
          if (file) void download(file)
        }}
        text={textQuery.data?.text ?? null}
        loading={textQuery.isLoading}
      />
    </div>
  )
}
