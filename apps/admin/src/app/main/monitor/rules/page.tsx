'use client'

import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useStore } from '@tanstack/react-store'
import { useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmAction,
  DataTable,
  DictSelect,
  DisplayValue,
  DrawerForm,
  IconText,
  Input,
  RefreshButton,
  Switch,
  TableActions,
  Tag,
  TagsInput,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type {
  DataTableColumnDef,
  FormFieldContext,
  FormFieldSchema,
} from '@repo/ui'
import { AppErrorCodes } from '@repo/shared'
import type { AlertRuleModel, UpdateAlertRuleDto } from '@repo/shared'
import { InfoIcon, PencilIcon, PlusIcon, SearchIcon } from 'lucide-react'

type RuleForm = {
  name: string
  type: 'tech' | 'business' | 'metric' | 'surge'
  matchCodes: number[]
  keywords: string[]
  threshold: number
  thresholdWindowSeconds: number
  metric?: string
  operator?: 'gt' | 'gte' | 'lt' | 'lte'
  thresholdValue?: number
  periodSeconds: number
  level: 'warn' | 'error'
  channels: ('file' | 'lark' | 'email')[]
  throttleSeconds: number
  enabled: boolean
}

const CHANNEL_OPTIONS = [
  { label: '文件', value: 'file' },
  { label: '飞书', value: 'lark' },
  { label: '邮件', value: 'email' },
]

/** 内置指标选项（metric / surge 规则；可自由输入自定义指标名） */
const METRIC_OPTIONS = [
  { label: '请求错误率（request.errorRate）', value: 'request.errorRate' },
  { label: 'QPS（request.qps）', value: 'request.qps' },
  { label: '平均耗时 ms（request.avgDuration）', value: 'request.avgDuration' },
  { label: 'P95 耗时 ms（request.p95）', value: 'request.p95' },
  { label: 'P99 耗时 ms（request.p99）', value: 'request.p99' },
  { label: '进程内存使用率（process.memory）', value: 'process.memory' },
]

/** 错误码选项：来自共享字典 AppErrorCodes（label 中文，value 数字码） */
const ERROR_CODE_OPTIONS = AppErrorCodes.options.map((option) => ({
  label: `${option.value} ${option.label}`,
  value: option.value,
}))

/** 比较符显示映射 */
const operatorMap = { gt: '>', gte: '≥', lt: '<', lte: '≤' } as const

const ruleToForm = (rule: AlertRuleModel): RuleForm => ({
  name: rule.name,
  type: rule.type,
  matchCodes: rule.matchCodes,
  keywords: rule.keywords,
  threshold: rule.threshold,
  thresholdWindowSeconds: rule.thresholdWindowSeconds,
  metric: rule.metric ?? undefined,
  operator: rule.operator ?? undefined,
  thresholdValue: rule.thresholdValue ?? undefined,
  periodSeconds: rule.periodSeconds,
  level: rule.level,
  channels: rule.channels,
  throttleSeconds: rule.throttleSeconds,
  enabled: rule.enabled,
})

export default function AlertRulesPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [type, setType] = useState<
    'tech' | 'business' | 'metric' | 'surge' | undefined
  >()
  const [enabled, setEnabled] = useState<boolean | undefined>()
  const createDialog = useDisclosure()
  const editDialog = useDisclosure<AlertRuleModel>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['monitor', 'rules', { page, pageSize, keyword, type, enabled }],
    queryFn: () =>
      client.monitor.rule.pageQuery({
        page,
        size: pageSize,
        keyword,
        type,
        enabled,
        orderBy: 'updatedAt',
        order: 'desc',
      }),
  })

  const createMutation = useMutation({
    mutationFn: (input: RuleForm) => client.monitor.rule.create(input),
  })

  const updateMutation = useMutation({
    mutationFn: (input: UpdateAlertRuleDto) => client.monitor.rule.update(input),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { ruleId: string }) => client.monitor.rule.remove(input),
  })

  const form = useForm({
    defaultValues: {
      name: '',
      type: 'tech' as RuleForm['type'],
      matchCodes: [] as number[],
      keywords: [] as string[],
      threshold: 1,
      thresholdWindowSeconds: 60,
      metric: undefined as string | undefined,
      operator: undefined as RuleForm['operator'],
      thresholdValue: undefined as number | undefined,
      periodSeconds: 60,
      level: 'warn' as RuleForm['level'],
      channels: [] as RuleForm['channels'],
      throttleSeconds: 60,
      enabled: true,
    } as RuleForm,
    onSubmit: async ({ value }) => {
      if (editDialog.isOpen && editDialog.data) {
        await updateMutation.mutateAsync({
          ruleId: editDialog.data.id,
          ...value,
        })
        toastSuccess('规则已更新')
        editDialog.close()
      } else {
        await createMutation.mutateAsync(value)
        toastSuccess('规则已创建')
        createDialog.close()
      }
      refetch()
    },
  })

  /** 当前规则类型（条件渲染表单字段） */
  const ruleType = useStore(form.store, (state) => state.values.type) ?? 'tech'
  const isEventRule = ruleType === 'tech' || ruleType === 'business'

  /** 匹配规则说明（Drawer 顶部，按类型显示） */
  const matchRuleHint = (
    <Alert className="mb-1">
      <InfoIcon />
      <AlertTitle>{isEventRule ? '事件规则说明' : '指标 / 突变规则说明'}</AlertTitle>
      <AlertDescription>
        <ul className="mb-0 list-disc pl-4 text-xs leading-6">
          {isEventRule ? (
            <>
              <li>
                <b>技术告警</b>：匹配所有未捕获异常 / 系统错误（通常不选错误码，即匹配全部）；
                <b>业务告警</b>：匹配指定错误码的业务错误。
              </li>
              <li>
                <b>错误码</b>：选择要告警的错误码（不选 = 匹配全部）。
              </li>
              <li>
                <b>次数阈值</b>：窗口内同错误出现 ≥ N 次才告警（防偶发误报，默认 1）。
              </li>
              <li>
                <b>关键字</b>：错误消息包含任一关键字即触发（不填 = 不限制）。
              </li>
            </>
          ) : (
            <>
              <li>
                <b>指标规则</b>：周期采样指标值，超过阈值才告警（如错误率 {'>'} 5%、P99 {'>'} 500ms、
                库存 &lt; 10）。
              </li>
              <li>
                <b>突变规则</b>：当前窗口 / 前一窗口 的环比倍率，用于 QPS 飙升、请求洪峰、
                订单飙升等场景。
              </li>
              <li>
                <b>评估周期</b>：每 periodSeconds 评估一次；框架自动埋点提供
                request.* / process.* 指标，业务指标需业务方埋点后引用指标名。
              </li>
            </>
          )}
          <li>
            <b>限频</b>：同一规则 + 相同内容在窗口内只推送一次（防告警风暴）。
          </li>
        </ul>
      </AlertDescription>
    </Alert>
  )

  const ruleFormItems: Array<
    FormFieldSchema<RuleForm> | FormFieldSchema<RuleForm>[]
  > = [
      {
        name: 'name',
        label: '规则名称',
        required: '请输入规则名称',
      },
      {
        name: 'type',
        label: '类型',
        required: true,
        widget: 'select',
        props: {
          options: [
            { label: '技术告警（事件：未捕获异常 / 系统错误）', value: 'tech' },
            { label: '业务告警（事件：指定错误码 / 关键字）', value: 'business' },
            { label: '指标告警（阈值：错误率 / P95 / 库存等）', value: 'metric' },
            { label: '突变告警（环比：QPS 飙升 / 洪峰 / 订单飙升）', value: 'surge' },
          ],
        },
      },
      // ===== 事件规则字段 =====
      ...(isEventRule
        ? [
            {
              name: 'matchCodes',
              label: '匹配错误码',
              widget: 'select' as const,
              hint: '不选 = 匹配该类型全部错误',
              props: {
                multiple: true,
                placeholder: '选择要告警的错误码（可多选）',
                options: ERROR_CODE_OPTIONS,
              },
            },
            {
              name: 'keywords',
              label: '消息关键字',
              hint: '错误消息包含任一关键字即触发；回车添加',
              render: ({ values, field }: FormFieldContext<RuleForm>) => (
                <TagsInput
                  value={(values.keywords ?? []) as string[]}
                  placeholder="输入关键字后回车（如：数据库、超时）"
                  onChange={(next) => field.handleChange(next)}
                />
              ),
            },
            {
              name: 'threshold',
              label: '触发阈值（次数）',
              widget: 'number' as const,
              hint: '窗口内同错误出现 ≥ N 次才告警',
            },
            {
              name: 'thresholdWindowSeconds',
              label: '统计窗口（秒）',
              widget: 'number' as const,
            },
          ]
        : [
            // ===== 指标 / 突变规则字段 =====
            {
              name: 'metric',
              label: ruleType === 'surge' ? '监控指标（环比）' : '监控指标',
              required: '请选择或输入指标名',
              hint:
                ruleType === 'surge'
                  ? '当前窗口 / 前一窗口 的环比倍率'
                  : '周期采样该指标值 vs 阈值',
              render: ({ values, field }: FormFieldContext<RuleForm>) => (
                <TagsInput
                  value={
                    values.metric ? [values.metric as string] : []
                  }
                  maxCount={1}
                  options={METRIC_OPTIONS}
                  placeholder="选择内置指标或输入自定义指标名"
                  onChange={(next) => field.handleChange(next[0])}
                />
              ),
            },
            {
              name: 'operator',
              label: '比较符',
              required: true,
              widget: 'select' as const,
              props: {
                options: [
                  { label: '>（大于）', value: 'gt' },
                  { label: '≥（大于等于）', value: 'gte' },
                  { label: '<（小于）', value: 'lt' },
                  { label: '≤（小于等于）', value: 'lte' },
                ],
              },
            },
            {
              name: 'thresholdValue',
              label: ruleType === 'surge' ? '环比倍率' : '阈值',
              required: '请输入阈值',
              widget: 'number' as const,
              hint:
                ruleType === 'surge'
                  ? '如 3 = 当前窗口是前一窗口 3 倍时告警'
                  : '如错误率 0.05、P99 500、库存 10',
            },
            {
              name: 'periodSeconds',
              label: '评估周期（秒）',
              widget: 'number' as const,
            },
          ]),
      {
        name: 'level',
        label: '级别',
        required: true,
        widget: 'select',
        props: {
          options: [
            { label: 'error（错误）', value: 'error' },
            { label: 'warn（警告）', value: 'warn' },
          ],
        },
      },
      {
        name: 'channels',
        label: '发送通道',
        required: '至少选择一个通道',
        widget: 'select',
        props: {
          multiple: true,
          options: CHANNEL_OPTIONS,
        },
      },
      {
        name: 'throttleSeconds',
        label: '限频窗口（秒）',
        widget: 'number',
      },
      {
        name: 'enabled',
        label: '启用',
        widget: 'switch',
      },
    ]

  const columns: DataTableColumnDef<AlertRuleModel>[] = [
    { header: '名称', accessorKey: 'name' },
    {
      header: '类型',
      accessorKey: 'type',
      meta: { width: 100 },
      cell: ({ getValue }) => {
        const map = {
          tech: { color: 'blue', label: '技术' },
          business: { color: 'orange', label: '业务' },
          metric: { color: 'green', label: '指标' },
          surge: { color: 'purple', label: '突变' },
        } as const
        const value = getValue() as keyof typeof map
        return <Tag color={map[value].color}>{map[value].label}</Tag>
      },
    },
    {
      header: '匹配条件',
      accessorKey: 'matchCodes',
      meta: { width: 200 },
      cell: ({ row }) => {
        if (row.original.type === 'metric' || row.original.type === 'surge') {
          const operator = operatorMap[
            row.original.operator as keyof typeof operatorMap
          ]
          return (
            <span className="text-xs text-muted-foreground">
              {row.original.metric} {operator} {row.original.thresholdValue}
              {row.original.type === 'surge' ? ' 倍' : ''}
            </span>
          )
        }
        return row.original.matchCodes.length === 0 ? (
          <Tag>全部</Tag>
        ) : (
          row.original.matchCodes.map((code) => (
            <Tag key={code}>{AppErrorCodes.getLabel(code) ?? code}</Tag>
          ))
        )
      },
    },
    {
      header: '级别',
      accessorKey: 'level',
      meta: { width: 80 },
      cell: ({ getValue }) =>
        getValue() === 'error' ? (
          <Tag color="red">error</Tag>
        ) : (
          <Tag color="gold">warn</Tag>
        ),
    },
    {
      header: '通道',
      accessorKey: 'channels',
      meta: { width: 140 },
      cell: ({ row }) =>
        row.original.channels.map((channel) => (
          <Tag key={channel} color="cyan">
            {channel === 'lark' ? '飞书' : channel === 'email' ? '邮件' : '文件'}
          </Tag>
        )),
    },
    { header: '限频(s)', accessorKey: 'throttleSeconds', meta: { width: 90 } },
    {
      header: '启用',
      accessorKey: 'enabled',
      meta: { width: 90 },
      cell: ({ row }) => (
        <Switch
          checked={row.original.enabled}
          disabled={updateMutation.isPending}
          aria-label="启用状态"
          onCheckedChange={(checked) => {
            updateMutation.mutate(
              { ruleId: row.original.id, enabled: checked },
              {
                onSuccess: () => refetch(),
                onError: () => toastError('操作失败'),
              },
            )
          }}
        />
      ),
    },
    {
      header: '创建时间',
      accessorKey: 'createdAt',
      meta: { width: 180 },
      cell: ({ getValue }) => <DisplayValue type="date" value={getValue()} />,
    },
    {
      header: '操作',
      meta: { width: 160 },
      cell: ({ row }) => (
        <TableActions>
          <IconText
            icon={<PencilIcon />}
            size="small"
            type="primary"
            onClick={() => {
              form.reset(ruleToForm(row.original))
              editDialog.open(row.original)
            }}
          >
            编辑
          </IconText>
          <ConfirmAction
            title={`确认删除规则「${row.original.name}」？`}
            onConfirm={() =>
              removeMutation.mutate(
                { ruleId: row.original.id },
                {
                  onSuccess: () => {
                    toastSuccess('删除成功')
                    refetch()
                  },
                },
              )
            }
            danger
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  return (
    <div className="h-full w-full overflow-auto p-4 sm:p-6">
      <DataTable<AlertRuleModel>
        title="告警规则"
        description="按错误码 / 关键词 / 指标阈值匹配异常，多通道通知"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg border border-input bg-background pr-1">
              <Input
                placeholder="搜索规则名..."
                value={searchText}
                onChange={(event) => {
                  setSearchText(event.target.value)
                  if (event.target.value === '') {
                    setKeyword(undefined)
                    setPage(1)
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setKeyword(searchText.trim() || undefined)
                    setPage(1)
                  }
                }}
                className="w-40 border-0 shadow-none focus-visible:ring-0"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="搜索"
                onClick={() => {
                  setKeyword(searchText.trim() || undefined)
                  setPage(1)
                }}
              >
                <SearchIcon />
              </Button>
            </div>
            <DictSelect
              options={[
                { label: '技术', value: 'tech' },
                { label: '业务', value: 'business' },
                { label: '指标', value: 'metric' },
                { label: '突变', value: 'surge' },
              ]}
              value={type ?? null}
              allowClear
              placeholder="全部"
              triggerClassName="w-24"
              onValueChange={(value) => {
                setType(
                  value === 'tech' ||
                    value === 'business' ||
                    value === 'metric' ||
                    value === 'surge'
                    ? value
                    : undefined,
                )
                setPage(1)
              }}
            />
            <DictSelect
              options={[
                { label: '启用', value: 'enabled' },
                { label: '禁用', value: 'disabled' },
              ]}
              value={enabled === undefined ? null : enabled ? 'enabled' : 'disabled'}
              allowClear
              placeholder="全部"
              triggerClassName="w-28"
              onValueChange={(value) => {
                setEnabled(
                  value === 'enabled'
                    ? true
                    : value === 'disabled'
                      ? false
                      : undefined,
                )
                setPage(1)
              }}
            />
            <Button onClick={() => createDialog.open()}>
              <PlusIcon />
              新建规则
            </Button>
          </>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        data={data?.items}
        page={page}
        pageSize={pageSize}
        total={data?.total}
        onPageChange={(nextPage, nextPageSize) => {
          setPage(nextPage)
          setPageSize(nextPageSize)
        }}
      />

      <DrawerForm<RuleForm>
        title="新建告警规则"
        open={createDialog.isOpen}
        form={form}
        width={520}
        description={matchRuleHint}
        items={ruleFormItems}
        onCancel={createDialog.close}
      />

      <DrawerForm<RuleForm>
        title="编辑告警规则"
        open={editDialog.isOpen}
        form={form}
        width={520}
        description={matchRuleHint}
        items={ruleFormItems}
        onCancel={editDialog.close}
      />
    </div>
  )
}
