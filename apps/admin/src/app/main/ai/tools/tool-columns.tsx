'use client'

import dedent from 'dedent'
import { ToolCategory, ToolScope, ToolSource } from '@repo/shared'
import type { AiToolModel } from '@repo/shared'
import {
  Button,
  ConfirmAction,
  DictTag,
  EmptyValue,
  IconText,
  Switch,
  TableActions,
  Tag,
  toastError,
  toastSuccess,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { CopyIcon, PencilIcon, RotateCcwIcon } from 'lucide-react'
import { copyText } from '@/lib/clipboard'

/**
 * 工具清单的表格列定义（`DataTable` 用）。
 *
 * 列定义与页面状态分开：列要知道的只是"怎么展示 + 点哪个回调"，
 * 所以行内操作（启停 / 编辑 / 恢复默认）都以回调注入，列本身不碰请求。
 */

export type ToolColumnsOptions = {
  /** 有更新请求在飞：行内开关先禁掉，避免连点打出一串并发写 */
  saving: boolean
  onToggleEnabled: (tool: AiToolModel, enabled: boolean) => void
  onEdit: (tool: AiToolModel) => void
  /** 恢复默认（含二次确认，确认后由调用方发请求） */
  onReset: (tool: AiToolModel) => void | Promise<void>
}

/** 复制工具 key：失败必须说出来（内网 http 下没有剪贴板 API，静默失败最难查） */
const copyToolKey = async (toolKey: string): Promise<void> => {
  try {
    await copyText(toolKey)
    toastSuccess('已复制工具 key', toolKey)
  } catch (error) {
    toastError(error instanceof Error ? error.message : String(error))
  }
}

/** 作用域单元格：`agent` 时把授权数量带上（"授权给哪些 agent"才是当下要看的） */
const ScopeCell = ({ tool }: { tool: AiToolModel }) => {
  if (tool.scope === ToolScope.Agent) {
    return (
      <Tag color="processing">{`指定 agent（${tool.allowedAgents.length}）`}</Tag>
    )
  }
  return <DictTag dict={ToolScope} value={tool.scope} emptyText={tool.scope} />
}

/** 类别单元格：runtime 是 Mastra 自带、不受开关控制，用不同颜色把它挑出来 */
const CategoryCell = ({ tool }: { tool: AiToolModel }) => {
  if (tool.category === ToolCategory.Runtime) {
    return <Tag color="warning">{ToolCategory.getLabel(tool.category)}</Tag>
  }
  return <DictTag dict={ToolCategory} value={tool.category} emptyText={tool.category} />
}

/** 限额摘要：三行紧凑展示（没配的显示"不限 / 用默认"） */
const LimitsCell = ({ tool }: { tool: AiToolModel }) => {
  const limits = tool.limits ?? {}
  // 单页字节以工具声明里的值为准，限额只是覆盖它
  const pageBytes = limits.pageBytes ?? tool.pageBytes
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      <span>
        每轮：
        <EmptyValue
          value={limits.maxPerTurn}
          emptyText={<span className="text-muted-foreground">不限</span>}
        >
          {limits.maxPerTurn}
        </EmptyValue>
      </span>
      <span>
        限流：
        <EmptyValue
          value={limits.rateLimit?.max}
          emptyText={<span className="text-muted-foreground">不限</span>}
        >
          {`${limits.rateLimit?.max} / ${limits.rateLimit?.windowSeconds}s`}
        </EmptyValue>
      </span>
      <span>
        单页：
        <EmptyValue
          value={pageBytes}
          emptyText={<span className="text-muted-foreground">用默认</span>}
        >
          {pageBytes?.toLocaleString()}
        </EmptyValue>
        {pageBytes ? ' 字节' : ''}
      </span>
    </div>
  )
}

/** 构建列定义（调用方把行内操作的回调注入进来） */
export const buildToolColumns = (
  options: ToolColumnsOptions,
): DataTableColumnDef<AiToolModel>[] => [
  {
    header: '工具 key',
    accessorKey: 'toolKey',
    meta: { width: 220 },
    cell: ({ row }) => (
      <div className="flex items-center gap-1">
        <span className="font-mono text-xs">{row.original.toolKey}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`复制工具 key ${row.original.toolKey}`}
          onClick={() => void copyToolKey(row.original.toolKey)}
        >
          <CopyIcon />
        </Button>
      </div>
    ),
  },
  {
    header: '标题',
    accessorKey: 'title',
    // 标题 / 说明是**代码声明的镜像**（启动期全量写入），页面只读、不做覆盖标记
    cell: ({ row }) => <span className="font-medium">{row.original.title}</span>,
  },
  {
    header: '类别',
    accessorKey: 'category',
    meta: { width: 110 },
    cell: ({ row }) => <CategoryCell tool={row.original} />,
  },
  {
    header: '启用',
    accessorKey: 'enabled',
    meta: { width: 80 },
    cell: ({ row }) => (
      <Switch
        checked={row.original.enabled}
        disabled={!row.original.editable || options.saving}
        aria-label={`${row.original.toolKey} 启用状态`}
        onCheckedChange={(checked) => options.onToggleEnabled(row.original, checked)}
      />
    ),
  },
  {
    header: '作用域',
    accessorKey: 'scope',
    meta: { width: 140 },
    cell: ({ row }) => <ScopeCell tool={row.original} />,
  },
  {
    header: '限额摘要',
    id: 'limits',
    meta: { width: 150 },
    cell: ({ row }) => <LimitsCell tool={row.original} />,
  },
  {
    header: '来源',
    accessorKey: 'source',
    meta: { width: 100 },
    cell: ({ row }) => (
      <DictTag dict={ToolSource} value={row.original.source} emptyText={row.original.source} />
    ),
  },
  {
    header: '操作',
    id: 'actions',
    meta: { width: 250 },
    cell: ({ row }) => (
      <TableActions>
        <IconText
          icon={<PencilIcon />}
          size="small"
          type="primary"
          disabled={!row.original.editable}
          onClick={() => options.onEdit(row.original)}
        >
          编辑
        </IconText>
        <ConfirmAction
          title={`确认把「${row.original.toolKey}」恢复默认？`}
          description={dedent`
            恢复默认会清掉这个工具的人工覆盖值（开关 / 作用域 / 指定 agent / 限额 / 工具专属配置 / 文案），
            回到代码声明的默认；已配置的秘钥会被一并清空，要重新填写。
          `}
          danger
          okText="恢复默认"
          disabled={!row.original.editable}
          onConfirm={() => options.onReset(row.original)}
        >
          恢复默认
        </ConfirmAction>
        <IconText
          icon={<CopyIcon />}
          size="small"
          onClick={() => void copyToolKey(row.original.toolKey)}
        >
          复制 key
        </IconText>
      </TableActions>
    ),
  },
]
