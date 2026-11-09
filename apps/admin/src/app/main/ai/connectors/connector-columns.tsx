'use client'

import dedent from 'dedent'
import { ConnectorStatus } from '@repo/shared'
import type { AiConnectorModel } from '@repo/shared'
import { ConfirmAction, DictTag, IconText, Switch, TableActions, Tag } from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { PencilIcon, PlugZapIcon, RefreshCwIcon } from 'lucide-react'

/**
 * 连接器清单的表格列（`DataTable` 用）。
 *
 * 三条与页面口径一致的展示规则：
 * - **状态只是"上次测试的结论"**：不是实时连接状态（本期不做常驻会话）；
 * - **型号单独一列**：`driver`（接法）与型号（PG / MySQL / Redis）是两件事；
 * - **操作分四个**：测试 / 同步 / 编辑 / 删除，都有明确的后果。
 */

export type ConnectorColumnsOptions = {
  saving: boolean
  onToggleEnabled: (row: AiConnectorModel, enabled: boolean) => void
  onEdit: (row: AiConnectorModel) => void
  onTest: (row: AiConnectorModel) => void | Promise<void>
  onSync: (row: AiConnectorModel) => void | Promise<void>
  onRemove: (row: AiConnectorModel) => void | Promise<void>
}

const StatusCell = ({ row }: { row: AiConnectorModel }) => (
  <div className="flex flex-col gap-1">
    <DictTag dict={ConnectorStatus} value={row.status} emptyText={row.status} />
    {row.lastError ? (
      <span className="max-w-[220px] truncate text-xs text-muted-foreground" title={row.lastError}>
        {row.lastError}
      </span>
    ) : null}
  </div>
)

export const buildConnectorColumns = (
  options: ConnectorColumnsOptions,
): DataTableColumnDef<AiConnectorModel>[] => [
  {
    header: '名称',
    accessorKey: 'name',
    cell: ({ row }) => (
      <div className="flex flex-col">
        <span className="font-medium">{row.original.name}</span>
        <span className="font-mono text-xs text-muted-foreground">{row.original.key}</span>
      </div>
    ),
  },
  {
    header: '型号',
    accessorKey: 'catalogKind',
    meta: { width: 120 },
    cell: ({ row }) => <Tag>{row.original.catalogKind || row.original.driver}</Tag>,
  },
  {
    header: '状态',
    accessorKey: 'status',
    meta: { width: 220 },
    cell: ({ row }) => <StatusCell row={row.original} />,
  },
  {
    header: '工具数',
    accessorKey: 'toolCount',
    meta: { width: 80 },
    cell: ({ row }) => <span className="tabular-nums">{row.original.toolCount}</span>,
  },
  {
    header: '启用',
    accessorKey: 'enabled',
    meta: { width: 80 },
    cell: ({ row }) => (
      <Switch
        checked={row.original.enabled}
        disabled={options.saving}
        aria-label={`${row.original.key} 启用状态`}
        onCheckedChange={(checked) => options.onToggleEnabled(row.original, checked === true)}
      />
    ),
  },
  {
    header: '操作',
    id: 'actions',
    meta: { width: 260 },
    cell: ({ row }) => (
      <TableActions>
        <IconText
          icon={<PlugZapIcon />}
          size="small"
          type="primary"
          disabled={options.saving}
          onClick={() => void options.onTest(row.original)}
        >
          测试
        </IconText>
        <IconText
          icon={<RefreshCwIcon />}
          size="small"
          disabled={options.saving}
          onClick={() => void options.onSync(row.original)}
        >
          同步
        </IconText>
        <IconText
          icon={<PencilIcon />}
          size="small"
          disabled={options.saving}
          onClick={() => options.onEdit(row.original)}
        >
          编辑
        </IconText>
        <ConfirmAction
          title={`确认删除连接器「${row.original.name}」？`}
          description={dedent`
            删除后它产出的工具会立刻不可调，工具行会保留（历史对话还引用着这些 key），
            但不会再出现在模型手上。密钥也随实例一起删除。
          `}
          danger
          okText="删除"
          disabled={options.saving}
          onConfirm={() => options.onRemove(row.original)}
        >
          删除
        </ConfirmAction>
      </TableActions>
    ),
  },
]
