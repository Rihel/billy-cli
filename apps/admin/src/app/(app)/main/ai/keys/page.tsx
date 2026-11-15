'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Button,
  ConfirmAction,
  DataTable,
  DictSelect,
  EmptyValue,
  IconText,
  ModalForm,
  RefreshButton,
  Tag,
  TableActions,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef, FormItem } from '@repo/ui'
import type {
  AiProviderKeyCreateDto,
  AiProviderKeyModel,
  AiProviderKeyUpdateDto,
} from '@repo/shared'
import { PencilIcon, PlusIcon, PowerIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'

/**
 * 上游 Key 池（`/main/ai/keys`）。
 *
 * 网关挑选上游密钥的顺序（`apps/model-gateway` 的 `ProviderKeyService.pick`）：
 * 按权重从**启用且未冷却、未超配额**的 key 里挑一把；池为空时回退到供应商上配的那把密钥。
 * 所以这个页面的三件事与运行时一一对应：
 * 1. **能挑到哪几把** —— 启用 / 停用（`status`）；
 * 2. **能挑多勤** —— `rpm` / `tpm` / 每日 token / 每日成本上限（达到即当天跳过）；
 * 3. **哪把在出问题** —— `failureCount`（401/403 连续 3 次会被网关自动停用）。
 *
 * 两条与后端约定绑定的口径：
 * - **密钥只进不出**：列表只有 `hasSecret`，明文永不回传；编辑时留空 = 不改，填写 = 轮换；
 * - **成本上限的单位是微元**：库里存 `dailyCostMicros`（1 元 = 1,000,000 微元），
 *   表单按「元」录入 / 回显，提交时换算，避免让人手填 6 个 0。
 */

/** 一把 key 的表单值（新建 / 编辑共用） */
type KeyForm = {
  label: string
  /** 明文密钥：仅新建必填；编辑留空 = 不修改 */
  secret: string
  enabled: boolean
  weight?: number
  rpm?: number
  tpm?: number
  dailyTokens?: number
  /** 日成本上限（元）；提交时换算成微元 */
  dailyCost?: number
}

/** 新建初值：一把 key 默认启用、权重 1、不设限 */
const KEY_FORM_DEFAULTS: KeyForm = {
  label: '',
  secret: '',
  enabled: true,
  weight: 1,
  rpm: undefined,
  tpm: undefined,
  dailyTokens: undefined,
  dailyCost: undefined,
}

/**
 * 编辑前的**清空值**。
 *
 * `ModalForm` 只回填**非 undefined** 的字段（见 `packages/ui/src/components/modal-form.tsx`），
 * 所以「留空 / 不限」的字段会保留上一条记录的值。编辑前先 reset 到这份全空值，
 * 再由 `values` 覆盖有值的键 —— 不能用 `form.reset(data)` 当回填手段。
 */
const KEY_FORM_BLANK: KeyForm = {
  label: '',
  secret: '',
  enabled: false,
  weight: undefined,
  rpm: undefined,
  tpm: undefined,
  dailyTokens: undefined,
  dailyCost: undefined,
}

/** 1 元 = 1,000,000 微元 */
const MICROS_PER_UNIT = 1_000_000

/** 数字上下限的非空值展示（`null` = 不限，不是 0） */
const formatLimit = (value: number | null | undefined): string | undefined =>
  value === null || value === undefined ? undefined : value.toLocaleString('zh-CN')

/** 微元 → 元（保留最多 6 位小数，够看清 0.000001 元这种粒度） */
const formatMicros = (micros: number | null | undefined): string | undefined => {
  if (micros === null || micros === undefined) return undefined
  return (micros / MICROS_PER_UNIT).toLocaleString('zh-CN', { maximumFractionDigits: 6 })
}

/** 元 → 微元；空 / 0 = 不设上限（null，避免把「0 元」误当成用不了） */
const toMicros = (yuan: number | undefined): number | null =>
  yuan === undefined || yuan <= 0 ? null : Math.round(yuan * MICROS_PER_UNIT)

/** 正整数校验文案（权重 / 限额都是 int；小数字段提交上去会被后端 400） */
const positiveIntError = (value: unknown, max?: number): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return '请输入正整数'
  }
  return max !== undefined && value > max ? `不能大于 ${max}` : undefined
}

export default function AiKeysPage() {
  const client = useServerClient()

  /** 当前供应商（key 池的作用域） */
  const [providerId, setProviderId] = useState<string>()
  /** 编辑回填值：走 `ModalForm` 的 `values`（不能 form.reset） */
  const [keyValues, setKeyValues] = useState<Partial<KeyForm>>()

  const createKeyDialog = useDisclosure()
  const editKeyDialog = useDisclosure<AiProviderKeyModel>()

  // 供应商是 key 池的作用域：一次取 100 家（后台供应商规模远小于这个数）
  const providersQuery = useQuery({
    queryKey: ['aiModel', 'provider', 'list', { page: 1, size: 100 }],
    queryFn: () => client.aiModel.provider.list({ page: 1, size: 100 }),
  })

  const keysQuery = useQuery({
    enabled: Boolean(providerId),
    queryKey: ['aiModel', 'provider', 'key', 'list', { providerId }],
    queryFn: () => client.aiModel.provider.key.list({ providerId: providerId! }),
  })

  // 首次拿到供应商列表时默认选中第一个：不选就看不到任何 key，进来会以为池是空的
  const autoSelectedRef = useRef(false)
  useEffect(() => {
    if (autoSelectedRef.current || providerId) return
    const first = providersQuery.data?.items[0]
    if (first) {
      autoSelectedRef.current = true
      setProviderId(first.id)
    }
  }, [providersQuery.data, providerId])

  const refetchProviders = providersQuery.refetch
  const refetchKeys = keysQuery.refetch

  const createKeyMutation = useMutation({
    mutationFn: (input: AiProviderKeyCreateDto) => client.aiModel.provider.key.create(input),
  })

  const updateKeyMutation = useMutation({
    mutationFn: (input: AiProviderKeyUpdateDto) => client.aiModel.provider.key.update(input),
  })

  const removeKeyMutation = useMutation({
    mutationFn: (input: { keyId: string }) => client.aiModel.provider.key.remove(input),
  })

  /** 从下拉里选供应商：切作用域并关掉可能开着的弹窗，避免「给 A 家建的 key 落在 B 家」 */
  const handleSelectProvider = (next: string | null) => {
    setProviderId(next ?? undefined)
    createKeyDialog.close()
    editKeyDialog.close()
  }

  const openCreateKey = () => {
    keyForm.reset(KEY_FORM_DEFAULTS)
    setKeyValues(undefined)
    createKeyDialog.open()
  }

  const openEditKey = (key: AiProviderKeyModel) => {
    // 先清成空壳（避免上一次编辑的残留串过来），再由 ModalForm 的 `values` 回填
    keyForm.reset(KEY_FORM_BLANK)
    setKeyValues({
      label: key.label,
      // 明文永不回传：输入框只能从空开始，留空 = 不改
      secret: '',
      enabled: key.status === 'active',
      weight: key.weight,
      rpm: key.rpm ?? undefined,
      tpm: key.tpm ?? undefined,
      dailyTokens: key.dailyTokens ?? undefined,
      dailyCost: key.dailyCostMicros === null ? undefined : key.dailyCostMicros / MICROS_PER_UNIT,
    })
    editKeyDialog.open(key)
  }

  /** 启用 / 停用（只改 status，不动其他字段） */
  const toggleStatus = (key: AiProviderKeyModel) => {
    const nextActive = key.status !== 'active'
    updateKeyMutation.mutate(
      { keyId: key.id, status: nextActive ? 'active' : 'disabled' },
      {
        onSuccess: () => {
          toastSuccess(nextActive ? '已启用这把 key' : '已停用这把 key')
          void refetchKeys()
        },
      },
    )
  }

  const keyForm = useForm({
    defaultValues: KEY_FORM_DEFAULTS,
    onSubmit: async ({ value }) => {
      const label = value.label.trim()
      const secret = value.secret.trim()
      const status = value.enabled ? 'active' : 'disabled'

      if (editKeyDialog.isOpen && editKeyDialog.data) {
        await updateKeyMutation.mutateAsync({
          keyId: editKeyDialog.data.id,
          label,
          // 密钥三态：留空 = 不修改（省略），填写 = 轮换成新的
          ...(secret ? { secret } : {}),
          status,
          weight: value.weight ?? 1,
          // 清空限额 = 显式传 null（不是省略）；省略会被后端当成"不改"
          rpm: value.rpm ?? null,
          tpm: value.tpm ?? null,
          dailyTokens: value.dailyTokens ?? null,
          dailyCostMicros: toMicros(value.dailyCost),
        })
        toastSuccess('Key 已更新')
        editKeyDialog.close()
      } else {
        if (!providerId) return
        await createKeyMutation.mutateAsync({
          providerId,
          label,
          secret,
          status,
          weight: value.weight ?? 1,
          rpm: value.rpm ?? null,
          tpm: value.tpm ?? null,
          dailyTokens: value.dailyTokens ?? null,
          dailyCostMicros: toMicros(value.dailyCost),
        })
        toastSuccess('Key 已加入池子', '网关会按权重挑选启用中的 key')
        createKeyDialog.close()
      }
      void refetchKeys()
    },
  })

  const keyFormItems = (isEdit: boolean): FormItem<KeyForm>[] => [
    {
      title: 'Key 信息',
      fields: [
        {
          name: 'label',
          label: '名称',
          required: '请输入名称',
          hint: '便于识别的名字，如「主账号」「备用 1」；同一供应商下建议唯一',
          validate: (value) =>
            typeof value === 'string' && value.trim().length > 64 ? '最长 64 个字符' : undefined,
        },
        {
          name: 'secret',
          label: '密钥',
          widget: 'password',
          // 新建必须有密钥；编辑留空 = 不修改（列表只显示 hasSecret，明文不回传）
          required: isEdit ? undefined : '请输入密钥',
          hint: isEdit
            ? '留空表示不修改；填写即轮换成新密钥（明文不会回显）'
            : '加密存储，明文永不回传；列表只显示是否已配置',
          validate: (value) =>
            typeof value === 'string' && value.length > 512 ? '最长 512 个字符' : undefined,
        },
        {
          name: 'enabled',
          label: '启用',
          widget: 'switch',
          hint: '停用后网关不再挑这把 key（401/403 连续 3 次也会被自动停用）',
        },
        {
          name: 'weight',
          label: '权重',
          widget: 'number',
          props: { min: 1, max: 1000, step: 1 },
          hint: '加权随机：权重越大被选中概率越高，默认 1（上限 1000）',
          validate: (value) => positiveIntError(value, 1000),
        },
      ],
    },
    {
      title: '限流',
      description:
        '达到任一上限后这把 key 暂时不再被挑选（RPM / TPM 按分钟重置，日额度按自然日重置）',
      fields: [
        {
          name: 'rpm',
          label: '每分钟请求上限（RPM）',
          widget: 'number',
          props: { min: 1, step: 1 },
          hint: '留空表示不限',
          validate: (value) => positiveIntError(value),
        },
        {
          name: 'tpm',
          label: '每分钟 token 上限（TPM）',
          widget: 'number',
          props: { min: 1, step: 1 },
          hint: '留空表示不限',
          validate: (value) => positiveIntError(value),
        },
        {
          name: 'dailyTokens',
          label: '每日 token 上限',
          widget: 'number',
          props: { min: 1, step: 1 },
          hint: '留空表示不限',
          validate: (value) => positiveIntError(value),
        },
        {
          name: 'dailyCost',
          label: '每日成本上限（元）',
          widget: 'number',
          props: { min: 0, step: 0.01 },
          hint: '按模型配置的币种累计（默认 CNY）；留空 / 0 表示不限，保存时换算成微元',
          validate: (value) => (typeof value === 'number' && value < 0 ? '不能是负数' : undefined),
        },
      ],
    },
  ]

  const providerOptions = (providersQuery.data?.items ?? []).map((provider) => ({
    label: provider.enabled ? provider.name : `${provider.name}（已停用）`,
    value: provider.id,
  }))

  const columns: DataTableColumnDef<AiProviderKeyModel>[] = [
    {
      header: '名称',
      accessorKey: 'label',
      meta: { width: 200 },
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">{row.original.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{row.original.id}</span>
        </div>
      ),
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 90 },
      cell: ({ row }) =>
        row.original.status === 'active' ? (
          <Tag color="success">启用</Tag>
        ) : (
          <Tag color="warning">停用</Tag>
        ),
    },
    {
      header: '权重',
      accessorKey: 'weight',
      meta: { width: 80 },
      cell: ({ row }) => <span className="font-mono text-xs">×{row.original.weight}</span>,
    },
    {
      header: 'RPM / TPM',
      accessorKey: 'rpm',
      meta: { width: 150 },
      cell: ({ row }) => (
        <div className="flex flex-col gap-0.5 font-mono text-xs">
          <span>RPM {formatLimit(row.original.rpm) ?? '不限'}</span>
          <span className="text-muted-foreground">
            TPM {formatLimit(row.original.tpm) ?? '不限'}
          </span>
        </div>
      ),
    },
    {
      header: '日 token 上限',
      accessorKey: 'dailyTokens',
      meta: { width: 130 },
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.dailyTokens}
          emptyText={<span className="text-muted-foreground">不限</span>}
        >
          <span className="font-mono text-xs">{formatLimit(row.original.dailyTokens)}</span>
        </EmptyValue>
      ),
    },
    {
      header: '日成本上限（元）',
      accessorKey: 'dailyCostMicros',
      meta: { width: 140 },
      cell: ({ row }) => (
        <EmptyValue
          value={row.original.dailyCostMicros}
          emptyText={<span className="text-muted-foreground">不限</span>}
        >
          <span className="font-mono text-xs">{formatMicros(row.original.dailyCostMicros)}</span>
        </EmptyValue>
      ),
    },
    {
      header: '密钥',
      accessorKey: 'hasSecret',
      meta: { width: 100 },
      cell: ({ row }) =>
        row.original.hasSecret ? (
          <Tag color="success">已配置</Tag>
        ) : (
          <Tag color="warning">未配置</Tag>
        ),
    },
    {
      header: '失败次数',
      accessorKey: 'failureCount',
      meta: { width: 90 },
      cell: ({ row }) => (
        <span
          className={
            row.original.failureCount > 0
              ? 'font-mono text-xs text-warning'
              : 'font-mono text-xs text-muted-foreground'
          }
        >
          {row.original.failureCount}
        </span>
      ),
    },
    {
      header: '操作',
      id: 'actions',
      meta: { width: 220 },
      cell: ({ row }) => {
        const active = row.original.status === 'active'
        return (
          <TableActions>
            <IconText
              icon={<PowerIcon />}
              size="small"
              type={active ? 'default' : 'primary'}
              disabled={updateKeyMutation.isPending}
              onClick={() => toggleStatus(row.original)}
            >
              {active ? '停用' : '启用'}
            </IconText>
            <IconText
              icon={<PencilIcon />}
              size="small"
              type="primary"
              onClick={() => openEditKey(row.original)}
            >
              编辑
            </IconText>
            <ConfirmAction
              title={`确认删除 key「${row.original.label}」？`}
              description="删除后网关不会再挑这把 key；如果池里没有别的可用 key，会回退到供应商上配置的密钥。"
              danger
              onConfirm={() =>
                removeKeyMutation.mutate(
                  { keyId: row.original.id },
                  {
                    onSuccess: () => {
                      toastSuccess('Key 已删除')
                      void refetchKeys()
                    },
                  },
                )
              }
            >
              删除
            </ConfirmAction>
          </TableActions>
        )
      },
    },
  ]

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto p-4 sm:py-6">
      <DataTable<AiProviderKeyModel>
        title="上游 Key 池"
        description="网关按权重从启用中的 key 里挑选；池为空时回退到供应商上配置的密钥。密钥只进不出，列表只显示是否已配置"
        toolbar={
          <>
            <DictSelect
              options={providerOptions}
              value={providerId ?? null}
              placeholder="选择供应商"
              size="sm"
              triggerClassName="w-56"
              disabled={providersQuery.isLoading}
              onValueChange={handleSelectProvider}
            />
            <RefreshButton
              loading={providersQuery.isFetching || keysQuery.isFetching}
              onClick={() => {
                void refetchProviders()
                if (providerId) void refetchKeys()
              }}
            />
            <Button disabled={!providerId} onClick={openCreateKey}>
              <PlusIcon />
              新增 Key
            </Button>
          </>
        }
        rowKey="id"
        loading={keysQuery.isFetching}
        columns={columns}
        data={providerId ? keysQuery.data : []}
        emptyText={
          providersQuery.data?.items.length === 0 ? (
            <span>
              还没有供应商：先到
              <Link
                className="text-primary underline-offset-4 hover:underline"
                href="/main/ai/models"
              >
                模型管理
              </Link>
              配一家供应商，再回来给它加 key
            </span>
          ) : providerId ? (
            '这个供应商的 key 池还是空的：网关会回退到供应商上配置的密钥；需要多把轮换 / 限流时点右上角「新增 Key」'
          ) : (
            '请先在右上角选择一个供应商，再查看 / 管理它的 key 池'
          )
        }
      />

      {/* 新建 / 编辑（同一个表单；编辑回填走 ModalForm 的 values） */}
      <ModalForm<KeyForm>
        title={editKeyDialog.isOpen ? '编辑上游 Key' : '新增上游 Key'}
        open={createKeyDialog.isOpen || editKeyDialog.isOpen}
        form={keyForm}
        // 编辑才回填；新建保持初值（避免上一次编辑的值出现在新建表单里）
        values={editKeyDialog.isOpen ? keyValues : undefined}
        dialogClassName="sm:max-w-xl"
        items={keyFormItems(editKeyDialog.isOpen)}
        description={
          editKeyDialog.isOpen
            ? '可改名称 / 启停 / 权重 / 限流；密钥留空表示不修改，填写即轮换。'
            : '一把上游密钥 = 池子里的一个候选；网关按权重挑选启用中的 key，达到限额就跳过。'
        }
        onCancel={() => {
          createKeyDialog.close()
          editKeyDialog.close()
        }}
      />
    </div>
  )
}
