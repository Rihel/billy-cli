'use client'

import dayjs from 'dayjs'
import { SkillSource } from '@repo/shared'
import type { AiSkillModel } from '@repo/shared'
import { ConfirmAction, DictTag, IconText, Switch, TableActions, Tag } from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { PencilIcon, Trash2Icon } from 'lucide-react'

/**
 * 技能库列表的列定义。
 *
 * 列只知道"怎么展示 + 点哪个回调"，请求与状态都在页面里；
 * 启停是行内开关（保存立即生效，不需要重启）。
 */
export type SkillColumnsOptions = {
  /** 有写请求在飞：行内开关与删除先禁掉，避免连点打出一串并发写 */
  saving: boolean
  onOpen: (skill: AiSkillModel) => void
  onToggleEnabled: (skill: AiSkillModel, enabled: boolean) => void
  onRemove: (skill: AiSkillModel) => void | Promise<void>
}

export const buildSkillColumns = (
  options: SkillColumnsOptions,
): DataTableColumnDef<AiSkillModel>[] => [
  {
    header: '技能',
    id: 'skill',
    meta: { width: 260 },
    cell: ({ row }) => (
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-xs font-medium">{row.original.skillKey}</span>
        <span className="truncate text-xs text-muted-foreground">{row.original.title}</span>
      </div>
    ),
  },
  {
    header: '何时使用（description）',
    id: 'description',
    cell: ({ row }) => (
      <p className="line-clamp-2 max-w-[420px] text-xs text-muted-foreground">
        {row.original.description}
      </p>
    ),
  },
  {
    header: '来源',
    accessorKey: 'source',
    meta: { width: 110 },
    cell: ({ row }) => (
      <DictTag dict={SkillSource} value={row.original.source} emptyText={row.original.source} />
    ),
  },
  {
    header: '文件',
    accessorKey: 'fileCount',
    meta: { width: 80 },
    cell: ({ row }) => <Tag>{`${row.original.fileCount} 个`}</Tag>,
  },
  {
    header: '启用',
    accessorKey: 'enabled',
    meta: { width: 80 },
    cell: ({ row }) => (
      <Switch
        checked={row.original.enabled}
        disabled={options.saving}
        aria-label={`${row.original.skillKey} 启用状态`}
        onCheckedChange={(checked) => options.onToggleEnabled(row.original, checked)}
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
    meta: { width: 160 },
    cell: ({ row }) => (
      <TableActions>
        <IconText
          icon={<PencilIcon />}
          size="small"
          type="primary"
          onClick={() => options.onOpen(row.original)}
        >
          编辑
        </IconText>
        <ConfirmAction
          title={`确认删除技能「${row.original.skillKey}」？`}
          description="删除会同时移除落盘目录，模型立刻看不到它；历史运行里的技能名不会再对应到任何技能。只是暂时不用请改启用开关。"
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
