'use client'

import { StorageAvatar } from '@/components/storage-avatar'
import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Button,
  ConfirmAction,
  DataTable,
  DictSelect,
  DisplayValue,
  EmptyValue,
  IconText,
  ImageUpload,
  Input,
  ModalForm,
  RefreshButton,
  Switch,
  TableActions,
  Tag,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import { UserStatus } from '@repo/shared'
import type { AdminModel } from '@repo/shared'
import { LockIcon, PencilIcon, PlusIcon, SearchIcon } from 'lucide-react'

type CreateAdminForm = {
  email: string
  password: string
  realName?: string
  avatar?: string
}

type EditAdminForm = {
  email: string
  realName?: string | null
  avatar?: string | null
  status: 'enabled' | 'disabled'
}

type ResetPasswordForm = {
  password: string
  confirmPassword: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function AdminsPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [status, setStatus] = useState<'enabled' | 'disabled' | undefined>()
  const createDialog = useDisclosure()
  const editDialog = useDisclosure<AdminModel>()
  const resetPasswordDialog = useDisclosure<AdminModel>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: [
      'admin',
      'findMany',
      { page, pageSize, keyword, status, orderBy: 'createdAt', order: 'desc' },
    ],
    queryFn: () =>
      client.admin.pageQuery({
        page,
        size: pageSize,
        keyword,
        status,
        orderBy: 'createdAt',
        order: 'desc',
      }),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { adminId: string }) => client.admin.remove(input),
    onSuccess() {
      void refetch()
      toastSuccess('删除成功')
    },
  })

  const statusMutation = useMutation({
    mutationFn: (input: { adminId: string; status: 'enabled' | 'disabled' }) =>
      client.admin.update(input),
    onSuccess() {
      void refetch()
    },
  })

  const createForm = useForm({
    defaultValues: {
      email: '',
      password: '',
      realName: '',
      avatar: '',
    } as CreateAdminForm,
    onSubmit: async ({ value }) => {
      await client.admin.create(value)
      toastSuccess('创建成功')
      await refetch()
      createDialog.close()
    },
  })

  const editForm = useForm({
    defaultValues: {
      email: '',
      realName: null,
      avatar: null,
      status: 'enabled',
    } as EditAdminForm,
    onSubmit: async ({ value }) => {
      if (!editDialog.data) return
      await client.admin.update({
        adminId: editDialog.data.id,
        realName: value.realName,
        avatar: value.avatar,
        status: value.status,
      })
      toastSuccess('更新成功')
      await refetch()
      editDialog.close()
    },
  })

  const resetPwdForm = useForm({
    defaultValues: { password: '', confirmPassword: '' },
    onSubmit: async ({ value }) => {
      if (!resetPasswordDialog.data) return
      await client.admin.resetPassword({
        adminId: resetPasswordDialog.data.id,
        password: value.password,
      })
      toastSuccess('密码重置成功')
      resetPasswordDialog.close()
    },
  })

  const columns: DataTableColumnDef<AdminModel>[] = [
    {
      header: '头像',
      accessorKey: 'avatar',
      meta: { width: 72 },
      cell: ({ row }) => (
        <StorageAvatar
          src={row.original.avatar}
          name={row.original.realName || row.original.email}
        />
      ),
    },
    {
      header: '邮箱',
      accessorKey: 'email',
      cell: ({ getValue }) => <span className="font-medium">{String(getValue())}</span>,
    },
    {
      header: '姓名',
      accessorKey: 'realName',
      cell: ({ row }) => (
        <EmptyValue value={row.original.realName} emptyText={<Tag>未设置</Tag>}>
          <span className="text-muted-foreground">{row.original.realName}</span>
        </EmptyValue>
      ),
    },
    {
      header: '状态',
      accessorKey: 'status',
      meta: { width: 120 },
      cell: ({ row }) => (
        <Switch
          checked={row.original.status === 'enabled'}
          disabled={statusMutation.isPending}
          aria-label="启用状态"
          title={row.original.status === 'enabled' ? '已启用' : '已禁用'}
          onCheckedChange={(checked) => {
            statusMutation.mutate(
              {
                adminId: row.original.id,
                status: checked ? 'enabled' : 'disabled',
              },
              {
                onSuccess: () => toastSuccess(checked ? '已启用' : '已禁用'),
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
      cell: ({ getValue }) => (
        <DisplayValue type="date" value={getValue()} className="text-xs text-muted-foreground" />
      ),
    },
    {
      header: '操作',
      meta: { width: 220 },
      cell: ({ row }) => (
        <TableActions>
          <IconText
            icon={<PencilIcon />}
            size="small"
            type="primary"
            onClick={() => {
              editForm.reset(row.original)
              editDialog.open(row.original)
            }}
          >
            编辑
          </IconText>
          <IconText
            icon={<LockIcon />}
            size="small"
            type="primary"
            onClick={() => resetPasswordDialog.open(row.original)}
          >
            重置密码
          </IconText>
          <ConfirmAction
            title="确认删除该管理员？"
            onConfirm={() => removeMutation.mutate({ adminId: row.original.id })}
            danger
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  return (
    <div className="h-full w-full overflow-auto p-4 sm:py-6">
      <DataTable<AdminModel>
        title="管理员管理"
        description="后台管理员账号管理，可重置密码与启停账号"
        toolbar={
          <>
            <RefreshButton loading={isFetching} onClick={() => void refetch()} />
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 px-2 transition-colors focus-within:ring-2 focus-within:ring-ring/40">
              <SearchIcon className="ml-0.5 size-3.5 text-muted-foreground" />
              <Input
                placeholder="搜索邮箱..."
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
                className="h-7 w-44 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </div>
            <DictSelect
              dict={UserStatus}
              value={status ?? null}
              allowClear
              placeholder="全部"
              triggerClassName="w-24"
              onValueChange={(value) => {
                setStatus(value === 'enabled' || value === 'disabled' ? value : undefined)
                setPage(1)
              }}
            />
            <Button onClick={() => createDialog.open()}>
              <PlusIcon />
              新建管理员
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

      {/* 新建管理员 */}
      <ModalForm<CreateAdminForm>
        title="新建管理员"
        open={createDialog.isOpen}
        form={createForm}
        items={[
          {
            name: 'email',
            label: '邮箱',
            hint: '登录用的邮箱地址，创建后不可修改',
            required: true,
            validate: (value) => {
              if (typeof value === 'string' && value && !EMAIL_PATTERN.test(value)) {
                return '请输入有效邮箱'
              }
              return undefined
            },
          },
          {
            name: 'realName',
            label: '姓名',
            hint: '管理员展示名，不填则显示邮箱前缀',
          },
          {
            name: 'avatar',
            label: '头像',
            hint: '支持常见图片格式，大小不超过 5MB',
            render: ({ values, field }) => (
              <ImageUpload
                value={(values.avatar as string | null | undefined) ?? undefined}
                sizeLimit={5}
                className="size-28"
                onChange={(key) => field.handleChange(key)}
              />
            ),
          },
          {
            name: 'password',
            label: '初始密码',
            hint: '至少 6 位；建议字母、数字与符号混合',
            widget: 'password',
            required: true,
            validate: (value) =>
              typeof value === 'string' && value.length > 0 && value.length < 6
                ? '至少 6 位'
                : undefined,
          },
        ]}
        onCancel={createDialog.close}
      />

      {/* 编辑用户 */}
      <ModalForm<EditAdminForm>
        title="编辑用户"
        open={editDialog.isOpen}
        form={editForm}
        values={editDialog.data}
        items={[
          {
            name: 'email',
            label: '邮箱',
            hint: '登录用邮箱，不可修改',
            disabled: true,
            props: { readOnly: true },
          },
          {
            name: 'realName',
            label: '姓名',
            hint: '展示名称，不填则显示邮箱前缀',
          },
          {
            name: 'avatar',
            label: '头像',
            hint: '支持常见图片格式，大小不超过 5MB',
            render: ({ values, field }) => (
              <ImageUpload
                value={(values.avatar as string | null | undefined) ?? undefined}
                sizeLimit={5}
                className="size-28"
                onChange={(key) => field.handleChange(key)}
              />
            ),
          },
          {
            name: 'status',
            label: '状态',
            hint: '禁用后该账号将无法登录',
            widget: 'select',
            props: { options: UserStatus.options },
          },
        ]}
        onCancel={editDialog.close}
      />

      {/* 重置密码 */}
      <ModalForm<ResetPasswordForm>
        title={`重置密码（${resetPasswordDialog.data?.email ?? ''}）`}
        open={resetPasswordDialog.isOpen}
        form={resetPwdForm}
        submitText="确认重置"
        items={[
          {
            name: 'password',
            label: '新密码',
            hint: '至少 6 位；建议字母、数字与符号混合',
            widget: 'password',
            required: true,
            validate: (value) =>
              typeof value === 'string' && value.length > 0 && value.length < 6
                ? '至少 6 位'
                : undefined,
          },
          {
            name: 'confirmPassword',
            label: '确认密码',
            hint: '再次输入新密码，两次需一致',
            widget: 'password',
            required: true,
            validate: (value, values) => (value !== values.password ? '两次密码不一致' : undefined),
          },
        ]}
        onCancel={resetPasswordDialog.close}
      />
    </div>
  )
}
