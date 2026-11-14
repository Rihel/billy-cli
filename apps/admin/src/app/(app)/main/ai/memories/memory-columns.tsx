'use client'

import dayjs from 'dayjs'
import { AiMemoryKind, AiMemorySource } from '@repo/shared'
import type { AiMemoryModel } from '@repo/shared'
import { ConfirmAction, DictTag, IconText, Switch, TableActions } from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { PencilIcon, Trash2Icon } from 'lucide-react'

/**
 * 记忆列表的列定义。
 *
 * 列只知道"怎么展示 + 点哪个回调"，请求与状态在页面里；
 * 启停与置顶是行内开关（保存立即生效，下一轮就不再注入 / 开始每轮带上）。
 */
export type MemoryColumnsOptions = {
  /** 有写请求在飞：行内开关与删除先禁掉，避免连点打出一串并发写 */
  saving: boolean
  onEdit: (memory: AiMemoryModel) => void
  onToggle: (memory: AiMemoryModel, patch: { enabled?: boolean; pinned?: boolean }) => void
  onRemove: (memory: AiMemoryModel) => void | Promise<void>
}

export const buildMemoryColumns = (
  options: MemoryColumnsOptions,
): DataTableColumnDef<AiMemoryModel>[] => [
  {
    header: '归属',
    accessorKey: 'userId',
    meta: { width: 150 },
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-xs">{row.original.userId}</span>
        <span className="text-[11px] text-muted-foreground">
          {row.original.agentKey ?? '全部 agent'}
        </span>
      </div>
    ),
  },
  {
    header: '类型',
    accessorKey: 'kind',
    meta: { width: 90 },
    cell: ({ row }) => (
      <DictTag dict={AiMemoryKind} value={row.original.kind} emptyText={row.original.kind} />
    ),
  },
  {
    header: '内容',
    id: 'content',
    cell: ({ row }) => <p className="line-clamp-2 max-w-[460px] text-xs">{row.original.content}</p>,
  },
  {
    header: '来源',
    accessorKey: 'source',
    meta: { width: 110 },
    cell: ({ row }) => (
      <DictTag dict={AiMemorySource} value={row.original.source} emptyText={row.original.source} />
    ),
  },
  {
    header: '置顶',
    accessorKey: 'pinned',
    meta: { width: 70 },
    cell: ({ row }) => (
      <Switch
        checked={row.original.pinned}
        disabled={options.saving}
        aria-label={`${row.original.id} 置顶状态`}
        onCheckedChange={(checked) => options.onToggle(row.original, { pinned: checked === true })}
      />
    ),
  },
  {
    header: '启用',
    accessorKey: 'enabled',
    meta: { width: 70 },
    cell: ({ row }) => (
      <Switch
        checked={row.original.enabled}
        disabled={options.saving}
        aria-label={`${row.original.id} 启用状态`}
        onCheckedChange={(checked) => options.onToggle(row.original, { enabled: checked === true })}
      />
    ),
  },
  {
    header: '更新时间',
    accessorKey: 'updatedAt',
    meta: { width: 140 },
    cell: ({ row }) =>
      row.original.updatedAt ? (
        <span className="text-xs text-muted-foreground">
          {dayjs(row.original.updatedAt).format('MM-DD HH:mm')}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      ),
  },
  {
    header: '操作',
    id: 'actions',
    meta: { width: 150 },
    cell: ({ row }) => (
      <TableActions>
        <IconText
          icon={<PencilIcon />}
          size="small"
          type="primary"
          onClick={() => options.onEdit(row.original)}
        >
          编辑
        </IconText>
        <ConfirmAction
          title="确认删除这条记忆？"
          description="删除后下一轮不再注入；数据仍在库里（软删），需要时可从审计里找回。只是暂时不用请改启用开关。"
          danger
          okText="删除"
          disabled={options.saving}
          onConfirm={() => options.onRemove(row.original)}
        >
          <Trash2Icon className="size-3.5" />
          删除
        </ConfirmAction>
      </TableActions>
    ),
  },
]
