'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type {
  MonitorRuleDefinitionModel,
  MonitorRuleModel,
  UpdateMonitorRuleDto,
} from '@repo/shared'
import {
  Button,
  DataTable,
  DictSelect,
  DisplayValue,
  Input,
  RefreshButton,
  Switch,
  Tag,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { PencilIcon, SearchIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import { RuleFormModal } from './rule-form'

const LEVEL_META = {
  warn: { label: '警告', color: 'warning' },
  error: { label: '错误', color: 'error' },
  critical: { label: '严重', color: 'error' },
} as const

export default function MonitorRulesPage() {
  const client = useServerClient()
  const [category, setCategory] = useState<'system' | 'business' | undefined>()
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const editDialog = useDisclosure<MonitorRuleModel>()

  const definitionsQuery = useQuery({
    queryKey: ['monitor', 'rule', 'definitions'],
    queryFn: () => client.monitor.rule.definitions(),
  })
  const rulesQuery = useQuery({
    queryKey: ['monitor', 'rule', 'list', { category, keyword }],
    queryFn: () => client.monitor.rule.list({ category, keyword }),
  })

  const definitions = useMemo(
    () => new Map((definitionsQuery.data ?? []).map((item) => [item.key, item])),
    [definitionsQuery.data],
  )

  const updateMutation = useMutation({
    mutationFn: (input: UpdateMonitorRuleDto) => client.monitor.rule.update(input),
  })
  const resetMutation = useMutation({
    mutationFn: (ruleKey: string) => client.monitor.rule.reset({ ruleKey }),
  })

  const refetch = () => void rulesQuery.refetch()

  const toggleEnabled = (rule: MonitorRuleModel, enabled: boolean) => {
    updateMutation.mutate(
      { ruleKey: rule.ruleKey, enabled },
      {
        onSuccess: () => {
          toastSuccess(enabled ? `已启用「${rule.name}」` : `已停用「${rule.name}」`)
          refetch()
        },
        onError: () => toastError('操作失败'),
      },
    )
  }

  const columns: DataTableColumnDef<MonitorRuleModel>[] = [
    {
      header: '规则',
      accessorKey: 'name',
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.original.name}</span>
          <span className="font-mono text-[11px] text-muted-foreground">{row.original.ruleKey}</span>
        </div>
      ),
    },
    {
      header: '分类 / 指标',
      accessorKey: 'metricKey',
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>{row.original.category === 'system' ? '系统' : '业务'}</span>
          <span className="font-mono">{row.original.metricKey ?? '事件规则'}</span>
        </div>
      ),
    },
    {
      header: '级别',
      // 列 id 必须唯一：相同的 accessorKey 会让 TanStack 生成同名列 id，
      // React 列表 key 随之重复（header 一次 + 每行 cell 一次），控制台刷屏告警
      id: 'level',
      accessorFn: (row) => row.config.level,
      meta: { width: 90 },
      cell: ({ row }) => {
        const meta = LEVEL_META[row.original.config.level] ?? LEVEL_META.warn
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      header: '阈值',
      id: 'threshold',
      accessorFn: (row) => row.config.threshold,
      meta: { width: 120 },
      cell: ({ row }) => (
        <span className="font-mono text-xs tabular-nums text-foreground/80">
          {operatorLabel(row.original.config.operator)} {row.original.config.threshold}
        </span>
      ),
    },
    {
      header: '周期 / 窗口',
      accessorKey: 'evaluationIntervalSeconds',
      meta: { width: 120 },
      cell: ({ row }) => (
        <span className="text-xs tabular-nums text-muted-foreground">
          {row.original.evaluationIntervalSeconds}s / {row.original.windowSeconds}s
        </span>
      ),
    },
    {
      header: '最近触发',
      accessorKey: 'lastFiredAt',
      meta: { width: 170 },
      cell: ({ getValue }) => (
        <DisplayValue
          type="date"
          value={getValue() as string | null | undefined}
          emptyText="从未"
          className="text-xs text-muted-foreground"
        />
      ),
    },
    {
      header: '启用',
      accessorKey: 'enabled',
      meta: { width: 80 },
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={updateMutation.isPending}
          aria-label="启用状态"
          onCheckedChange={(checked) => toggleEnabled(row.original, checked)}
        />
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 90 },
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => editDialog.open(row.original)}>
          <PencilIcon className="size-3.5" />
          编辑
        </Button>
      ),
    },
  ]

  const selectedDefinition: MonitorRuleDefinitionModel | undefined = editDialog.data
    ? definitions.get(editDialog.data.ruleKey)
    : undefined

  return (
    <div className="h-full w-full overflow-auto p-4 sm:py-6">
      <DataTable<MonitorRuleModel>
        title="告警规则"
        description="规则由代码定义；这里改阈值、级别、通道、静默期和开关，保存后下一轮评估生效。"
        toolbar={
          <>
            <RefreshButton
              loading={rulesQuery.isFetching || definitionsQuery.isFetching}
              onClick={() => {
                void definitionsQuery.refetch()
                void rulesQuery.refetch()
              }}
            />
            <DictSelect
              options={[
                { label: '系统', value: 'system' },
                { label: '业务', value: 'business' },
              ]}
              value={category ?? null}
              allowClear
              placeholder="全部分类"
              triggerClassName="w-28"
              onValueChange={(value) =>
                setCategory(value === 'system' || value === 'business' ? value : undefined)
              }
            />
          </>
        }
        search={
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              setKeyword(searchText.trim() || undefined)
            }}
          >
            <Input
              value={searchText}
              placeholder="搜索名称 / key"
              className="w-52"
              onChange={(event) => setSearchText(event.target.value)}
            />
            <Button type="submit" variant="outline" size="sm">
              <SearchIcon className="size-3.5" />
              搜索
            </Button>
          </form>
        }
        rowKey="id"
        loading={rulesQuery.isFetching}
        columns={columns}
        data={rulesQuery.data}
      />

      <RuleFormModal
        open={editDialog.isOpen}
        rule={editDialog.data ?? null}
        definition={selectedDefinition}
        saving={updateMutation.isPending || resetMutation.isPending}
        onSave={async (input) => {
          await updateMutation.mutateAsync(input)
          toastSuccess('规则配置已保存')
          refetch()
        }}
        onReset={async (ruleKey) => {
          await resetMutation.mutateAsync(ruleKey)
          toastSuccess('已恢复默认配置')
          refetch()
          editDialog.close()
        }}
        onClose={() => editDialog.close()}
      />
    </div>
  )
}

const operatorLabel = (operator: string): string => {
  switch (operator) {
    case 'gt':
      return '>'
    case 'gte':
      return '≥'
    case 'lt':
      return '<'
    case 'lte':
      return '≤'
    default:
      return operator
  }
}
