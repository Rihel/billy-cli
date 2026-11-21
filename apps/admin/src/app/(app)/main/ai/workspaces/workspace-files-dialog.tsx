'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { WorkspaceModel } from '@repo/shared'
import { Dialog, DialogContent, DialogHeader, DialogTitle, toastError } from '@repo/ui'
import type { ServerClient } from '@repo/sdk'
import {
  FilePreviewDialog,
  isPreviewTextItem,
  type PreviewDialogItem,
} from '@/components/file-preview-dialog'

/**
 * 工作区文件预览（后台工作区卡片上的「文件」）。
 *
 * **复用会话里那套预览**（`FilePreviewDialog`：左侧文件树 + 预览 / 代码切换 / 全屏 /
 * 上一条下一条），不另画一套列表 —— 同一个文件在工作区页与会话右栏看到的东西一致。
 *
 * 数据口径：
 * - 列表走 `/ai-workspace/files`（只读，工作区未运行会明确报错，不偷偷拉起容器）；
 * - 文本正文走 `/ai-workspace/file/read`（≤ 512KB），二进制走 `/ai-workspace/file/download`（≤ 8MB）。
 */
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'py',
  'go',
  'rs',
  'rb',
  'php',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'sh',
  'bash',
  'zsh',
  'sql',
  'ini',
  'conf',
  'toml',
  'log',
  'csv',
  'tsv',
  'graphql',
  'gql',
])

/** 明确知道类型的扩展名 → MIME（其余按 text/plain 或 octet-stream 兜底） */
const MEDIA_BY_EXT: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  js: 'application/javascript',
  mjs: 'application/javascript',
  ts: 'application/typescript',
  sql: 'application/sql',
}

const extOf = (path: string): string => {
  const base = path.split('/').pop() ?? path
  const index = base.lastIndexOf('.')
  return index > 0 ? base.slice(index + 1).toLowerCase() : ''
}

const mediaTypeOf = (path: string): string =>
  MEDIA_BY_EXT[extOf(path)] ??
  (TEXT_EXTS.has(extOf(path)) ? 'text/plain' : 'application/octet-stream')

export function WorkspaceFilesDialog({
  client,
  workspace,
  onClose,
}: {
  client: ServerClient
  workspace: WorkspaceModel | null
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)

  const filesQuery = useQuery({
    queryKey: ['workspace-files', workspace?.id],
    queryFn: () => client.workspace.files({ id: workspace?.id as string }),
    enabled: Boolean(workspace),
  })

  // 换一个工作区就回到第一个文件（否则会拿上一个工作区的位置去索引新列表）
  const workspaceId = workspace?.id ?? null
  useEffect(() => {
    setIndex(0)
  }, [workspaceId])

  const items = useMemo<PreviewDialogItem[]>(
    () =>
      [...(filesQuery.data?.entries ?? [])]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => ({
          id: `ws:${entry.path}`,
          filename: entry.path.split('/').pop() ?? entry.path,
          path: entry.path,
          mediaType: mediaTypeOf(entry.path),
          bytes: entry.size,
          url: null,
        })),
    [filesQuery.data],
  )

  const current = items[index] ?? null
  const textQuery = useQuery({
    queryKey: ['workspace-file-content', workspaceId, current?.path],
    queryFn: () =>
      client.workspace.readFile({ id: workspaceId as string, path: current?.path as string }),
    enabled: Boolean(workspaceId && current && isPreviewTextItem(current)),
    retry: false,
  })

  /** 下载：服务端读字节转 base64，这里还原成 Blob 交给浏览器（带体积上限） */
  const download = async (item: PreviewDialogItem): Promise<void> => {
    if (!workspaceId) return
    try {
      const file = await client.workspace.downloadFile({ id: workspaceId, path: item.path ?? '' })
      const binary = atob(file.base64)
      const bytes = new Uint8Array(binary.length)
      for (let position = 0; position < binary.length; position += 1) {
        bytes[position] = binary.charCodeAt(position)
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: item.mediaType }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.filename
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toastError(error instanceof Error ? error.message : '下载失败')
    }
  }

  if (!workspace) return null

  // 列表拿不到（未运行 / 读取失败）或工作区是空的：给一个说明弹窗，不渲染空树
  const blocked = filesQuery.isError
    ? filesQuery.error instanceof Error
      ? filesQuery.error.message
      : '读取工作区文件失败'
    : filesQuery.isSuccess && items.length === 0
      ? '工作区里还没有文件。会话里让 AI 写文件后会出现。'
      : null

  if (filesQuery.isLoading || blocked !== null) {
    return (
      <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-sm">{workspace.name} · 文件</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            {filesQuery.isLoading ? '正在读取工作区…' : blocked}
          </p>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <FilePreviewDialog
      items={items}
      index={items.length === 0 ? null : Math.min(index, items.length - 1)}
      onIndexChange={setIndex}
      onClose={onClose}
      onDownload={(item) => void download(item)}
      text={textQuery.data?.content ?? null}
      loading={textQuery.isLoading}
    />
  )
}
