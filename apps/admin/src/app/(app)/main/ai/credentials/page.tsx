'use client'

import { useServerClient } from '@/lib/server-client'
import { useAuthStore } from '@/stores/auth.store'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Button,
  ConfirmAction,
  DataTable,
  DisplayValue,
  EmptyValue,
  IconText,
  Input,
  ModalForm,
  RefreshButton,
  Tag,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import {
  CREDENTIAL_TEMPLATES,
  CredentialLifetime,
  CredentialStatus,
  credentialTemplateOf,
  type CredentialInjectRule,
  type CredentialModel,
  type CredentialTemplate,
} from '@repo/shared'
import { KeyRoundIcon, PencilIcon, PlusIcon, SearchIcon } from 'lucide-react'

/**
 * 个人凭据管理（`docs/design/workspace-cli-credentials.md` §6.4 / §6.10.2）。
 *
 * 三条界面口径：
 * - **值不回显**：列表只有 `config` 与 `secretHint`，页面没有任何"查看明文"的入口；
 * - **表单由模板驱动**：选 provider 后字段自动出现，不在这里手写每个服务的表单；
 * - **改映射不改值**：映射用 JSON 编辑（注入规则是平台设施，面向管理员）。
 */

/** 绑定表单：模板字段按 `v_<provider>_<key>` 命名，避免不同 provider 同名字段互相串值 */
type BindForm = {
  provider: string
  name: string
  lifetime: string
  expiresAt: string
} & Record<string, unknown>

/** 模板字段在表单里的字段名 */
const fieldNameOf = (provider: string, key: string): string => `v_${provider}_${key}`

const templateLabel = (provider: string): string =>
  credentialTemplateOf(provider)?.label ?? provider

const statusColor: Record<string, string> = {
  active: 'green',
  expired: 'orange',
  revoked: 'red',
}

const toFormValues = (template: CredentialTemplate): Record<string, unknown> => {
  const values: Record<string, unknown> = {}
  for (const field of template.fields) {
    if (field.default !== undefined)
      values[fieldNameOf(template.provider, field.key)] = field.default
  }
  return values
}

export default function CredentialsPage() {
  const client = useServerClient()
  const adminType = useAuthStore((s) => s.adminInfo?.type)
  const [keyword, setKeyword] = useState('')
  const bindDialog = useDisclosure()
  const injectDialog = useDisclosure<CredentialModel>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['aiCredential', 'list', { keyword }],
    queryFn: () => client.aiCredential.list({ keyword: keyword.trim() || undefined }),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { credentialId: string }) => client.aiCredential.remove(input),
    onSuccess() {
      void refetch()
      toastSuccess('已吊销')
    },
    onError: (error: unknown) => toastError(error instanceof Error ? error.message : '吊销失败'),
  })

  const bindForm = useForm({
    defaultValues: {
      provider: 'mysql',
      name: '',
      lifetime: 'long-term',
      expiresAt: '',
      ...toFormValues(
        CREDENTIAL_TEMPLATES.find((item) => item.provider === 'mysql') ?? CREDENTIAL_TEMPLATES[0],
      ),
    } as BindForm,
    onSubmit: async ({ value }) => {
      const template = credentialTemplateOf(value.provider)
      if (!template) {
        toastError('该服务没有可用的凭据模板')
        return
      }
      const values: Record<string, unknown> = {}
      for (const field of template.fields) {
        const raw = value[fieldNameOf(template.provider, field.key)]
        if (raw !== undefined && raw !== '') values[field.key] = raw
      }
      await client.aiCredential.create({
        provider: template.provider,
        name: value.name?.trim() || undefined,
        lifetime: value.lifetime === 'temporary' ? 'temporary' : 'long-term',
        expiresAt: value.lifetime === 'temporary' && value.expiresAt ? value.expiresAt : undefined,
        values,
      })
      toastSuccess('已绑定，初始化阶段会落地到新工作区')
      await refetch()
      bindDialog.close()
    },
  })

  const injectForm = useForm({
    defaultValues: { inject: '[]' },
    onSubmit: async ({ value }) => {
      if (!injectDialog.data) return
      let parsed: unknown
      try {
        parsed = JSON.parse(value.inject)
      } catch {
        toastError('映射不是合法 JSON')
        return
      }
      if (!Array.isArray(parsed)) {
        toastError('映射必须是数组')
        return
      }
      await client.aiCredential.updateInject({
        credentialId: injectDialog.data.id,
        inject: parsed as CredentialInjectRule[],
      })
      toastSuccess('映射已更新')
      await refetch()
      injectDialog.close()
    },
  })

  const columns: DataTableColumnDef<CredentialModel>[] = [
    {
      header: '服务',
      accessorKey: 'provider',
      meta: { width: 150 },
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5 font-medium">
          <KeyRoundIcon className="size-3.5 text-muted-foreground" />
          {templateLabel(row.original.provider)}
        </span>
      ),
    },
    { header: '名称', accessorKey: 'name', meta: { width: 140 } },
    {
      header: '凭据提示',
      accessorKey: 'secretHint',
      meta: { width: 150 },
      cell: ({ row }) => (
        <EmptyValue value={row.original.secretHint} emptyText={<Tag>无</Tag>}>
          <span className="font-mono text-xs">{row.original.secretHint}</span>
        </EmptyValue>
      ),
    },
    {
      header: '明文配置',
      accessorKey: 'config',
      cell: ({ row }) => {
        const entries = Object.entries(row.original.config)
        if (entries.length === 0) return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {entries.map(([key, value]) => (
              <Tag key={key} color="default">
                {key}={String(value)}
              </Tag>
            ))}
          </div>
        )
      },
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 96 },
      cell: ({ row }) => (
        <Tag color={statusColor[row.original.status] ?? 'default'}>
          {CredentialStatus.getLabel(row.original.status) ?? row.original.status}
        </Tag>
      ),
    },
    {
      header: '有效期',
      accessorKey: 'lifetime',
      meta: { width: 150 },
      cell: ({ row }) => (
        <div className="text-xs text-muted-foreground">
          <div>{CredentialLifetime.getLabel(row.original.lifetime) ?? row.original.lifetime}</div>
          {row.original.expiresAt ? (
            <DisplayValue type="date" value={row.original.expiresAt} />
          ) : null}
        </div>
      ),
    },
    {
      header: '最后使用',
      accessorKey: 'lastUsedAt',
      meta: { width: 160 },
      cell: ({ row }) => (
        <EmptyValue value={row.original.lastUsedAt} emptyText={<Tag>未使用</Tag>}>
          <DisplayValue
            type="date"
            value={row.original.lastUsedAt}
            className="text-xs text-muted-foreground"
          />
        </EmptyValue>
      ),
    },
    {
      header: '操作',
      meta: { width: 180 },
      cell: ({ row }) => (
        <div className="flex items-center gap-1">
          <IconText
            icon={<PencilIcon />}
            size="small"
            type="primary"
            onClick={() => {
              injectForm.setFieldValue('inject', JSON.stringify(row.original.inject, null, 2))
              injectDialog.open(row.original)
            }}
          >
            映射
          </IconText>
          <ConfirmAction
            title="确认吊销该凭据？容器内的凭据文件会在下次同步时删除。"
            onConfirm={() => removeMutation.mutate({ credentialId: row.original.id })}
            danger
          >
            吊销
          </ConfirmAction>
        </div>
      ),
    },
  ]

  // 超管额外看到归属（普通管理员只能看到自己的，这一列没有信息量）
  if (adminType === 'god') {
    columns.splice(5, 0, {
      header: '归属',
      accessorKey: 'ownerId',
      meta: { width: 150 },
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.original.ownerType}:{row.original.ownerId}
        </span>
      ),
    })
  }

  /** 绑定表单里"当前 provider 的模板字段"：其余 provider 的字段隐藏但保留在表单里 */
  const templateFields = CREDENTIAL_TEMPLATES.flatMap((template) =>
    template.fields.map((field) => ({
      name: fieldNameOf(template.provider, field.key),
      label: `${template.label} · ${field.label}`,
      widget:
        field.type === 'password'
          ? ('password' as const)
          : field.type === 'number'
            ? ('number' as const)
            : ('input' as const),
      hint: field.hint,
      placeholder: field.placeholder,
      required: field.required && field.default === undefined,
      hidden: (values: BindForm) => values.provider !== template.provider,
    })),
  )

  return (
    <div className="h-full w-full overflow-auto p-4 sm:py-6">
      <DataTable<CredentialModel>
        title="凭据管理"
        description="以个人身份托管 CLI / 数据库 / 云服务的凭据；值加密存储、不回显，初始化时落地到工作区"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索名称 / 服务 / 提示..."
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                className="h-7 w-52 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button onClick={() => bindDialog.open()}>
              <PlusIcon />
              绑定凭据
            </Button>
          </>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        data={data}
      />

      {/* 绑定凭据：字段由模板驱动 */}
      <ModalForm<BindForm>
        title="绑定凭据"
        open={bindDialog.isOpen}
        form={bindForm}
        dialogClassName="sm:max-w-2xl"
        description="凭据加密存储，任何角色都无法查看明文；同一个服务可以用不同名称绑定多个账号。"
        items={[
          {
            name: 'provider',
            label: '服务',
            widget: 'select',
            required: true,
            props: {
              options: CREDENTIAL_TEMPLATES.map((template) => ({
                label: template.label,
                value: template.provider,
              })),
            },
            hint: '选择后按模板采集字段，字段说明由模板提供',
          },
          {
            name: 'name',
            label: '名称',
            hint: '留空用服务名；同一服务多账号时用它区分（如 `biz-db`、`report-db`）',
          },
          {
            name: 'lifetime',
            label: '有效期口径',
            widget: 'select',
            props: {
              options: [
                { label: '长期', value: 'long-term' },
                { label: '临时', value: 'temporary' },
              ],
            },
            hint: '临时凭据（如两小时的 access token）需填到期时间，价值有限时优先走授权',
          },
          {
            name: 'expiresAt',
            label: '到期时间',
            widget: 'date',
            hidden: (values) => values.lifetime !== 'temporary',
          },
          ...templateFields,
        ]}
        onCancel={bindDialog.close}
        onError={(error) => toastError(error instanceof Error ? error.message : '绑定失败')}
      />

      {/* 修改映射：直接编辑注入规则（文件 / 环境变量） */}
      <ModalForm<{ inject: string }>
        title={`修改映射（${injectDialog.data?.name ?? ''}）`}
        open={injectDialog.isOpen}
        form={injectForm}
        submitText="保存映射"
        dialogClassName="sm:max-w-2xl"
        description={
          '注入规则示例：{"type":"file","path":"~/.my.cnf","template":"..."} 或 ' +
          '{"type":"env","name":"REDISCLI_AUTH","field":"password"}（整体是一个 JSON 数组）。只改映射，不改凭据值。'
        }
        items={[
          {
            name: 'inject',
            label: '注入规则（JSON 数组）',
            widget: 'textarea',
            required: true,
            props: { rows: 10, className: 'font-mono text-xs' },
          },
        ]}
        onCancel={injectDialog.close}
        onError={(error) => toastError(error instanceof Error ? error.message : '保存失败')}
      />

      <p className="mt-3 text-xs text-muted-foreground">
        字段去向由模板决定：密码 / 密钥进密文，host、端口、用户名等进明文配置；
        吊销后容器内的凭据文件随下次同步删除。凭据值对任何角色都不开放，页面只展示提示串。
      </p>
    </div>
  )
}
