'use client'

import { formatStorageUrl } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  ConfirmAction,
  DataTable,
  DisplayValue,
  EmptyValue,
  IconText,
  ImageUpload,
  Input,
  ModalForm,
  RefreshButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  TableActions,
  Tag,
  toastError,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataTableColumnDef } from '@repo/ui'
import type { UserModel } from '@repo/shared'
import { LockIcon, PencilIcon, PlusIcon, SearchIcon } from 'lucide-react'

type CreateUserForm = {
  email: string
  password: string
  realName?: string
  avatar?: string
}

type EditUserForm = {
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

const STATUS_OPTIONS = [
  { label: '启用', value: 'enabled' },
  { label: '禁用', value: 'disabled' },
]

export default function UsersPage() {
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [searchText, setSearchText] = useState('')
  const [status, setStatus] = useState<'enabled' | 'disabled' | undefined>()
  const createDialog = useDisclosure()
  const editDialog = useDisclosure<UserModel>()
  const resetPasswordDialog = useDisclosure<UserModel>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: [
      'user',
      'findMany',
      { page, pageSize, keyword, status, orderBy: 'createdAt', order: 'desc' },
    ],
    queryFn: () =>
      client.user.pageQuery({
        page,
        size: pageSize,
        keyword,
        status,
        orderBy: 'createdAt',
        order: 'desc',
      }),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { userId: string }) => client.user.remove(input),
    onSuccess() {
      refetch()
      toastSuccess('删除成功')
    },
  })

  const statusMutation = useMutation({
    mutationFn: (input: { userId: string; status: 'enabled' | 'disabled' }) =>
      client.user.update(input),
    onSuccess() {
      refetch()
    },
  })

  const createForm = useForm({
    defaultValues: {
        email: '',
        password: '',
        realName: '',
        avatar: '',
      } as CreateUserForm,
    onSubmit: async ({ value }) => {
      await client.user.create(value)
      toastSuccess('创建成功')
      refetch()
      createDialog.close()
    },
  })

  const editForm = useForm({
    defaultValues: {
      email: '',
      realName: null,
      avatar: null,
      status: 'enabled',
    } as EditUserForm,
    onSubmit: async ({ value }) => {
      if (!editDialog.data) return
      await client.user.update({
        userId: editDialog.data.id,
        realName: value.realName,
        avatar: value.avatar,
        status: value.status,
      })
      toastSuccess('更新成功')
      refetch()
      editDialog.close()
    },
  })

  const resetPwdForm = useForm({
    defaultValues: { password: '', confirmPassword: '' },
    onSubmit: async ({ value }) => {
      if (!resetPasswordDialog.data) return
      await client.user.resetPassword({
        userId: resetPasswordDialog.data.id,
        password: value.password,
      })
      toastSuccess('密码重置成功')
      resetPasswordDialog.close()
    },
  })

  const columns: DataTableColumnDef<UserModel>[] = [
    {
      header: '头像',
      accessorKey: 'avatar',
      meta: { width: 72 },
      cell: ({ row }) =>
        row.original.avatar ? (
          <Avatar className="size-8">
            <AvatarImage src={formatStorageUrl(row.original.avatar)} />
            <AvatarFallback>
              {(row.original.realName || row.original.email || 'U').slice(0, 1)}
            </AvatarFallback>
          </Avatar>
        ) : null,
    },
    { header: '邮箱', accessorKey: 'email' },
    {
      header: '姓名',
      accessorKey: 'realName',
      cell: ({ row }) => (
        <EmptyValue value={row.original.realName} emptyText={<Tag>未设置</Tag>}>
          {row.original.realName}
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
                userId: row.original.id,
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
      cell: ({ getValue }) => <DisplayValue type="date" value={getValue()} />,
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
            title="确认删除该用户？"
            onConfirm={() => removeMutation.mutate({ userId: row.original.id })}
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
      <DataTable<UserModel>
        title="用户管理"
        toolbar={
          <>
            <RefreshButton
              loading={isFetching}
              onClick={() => void refetch()}
            />
            <div className="flex items-center gap-1 rounded-lg border border-input bg-background pr-1">
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
                className="w-44 border-0 shadow-none focus-visible:ring-0"
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
            <Select
              value={status ?? '__all'}
              onValueChange={(value) => {
                setStatus(
                  value === '__all' ? undefined : (value as 'enabled' | 'disabled'),
                )
                setPage(1)
              }}
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">全部</SelectItem>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={() => createDialog.open()}>
              <PlusIcon />
              新建用户
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

      {/* 新建用户 */}
      <ModalForm<CreateUserForm>
        title="新建用户"
        open={createDialog.isOpen}
        form={createForm}
        items={[
          {
            name: 'email',
            label: '邮箱',
            required: true,
            validate: (value) => {
              if (
                typeof value === 'string' &&
                value &&
                !EMAIL_PATTERN.test(value)
              ) {
                return '请输入有效邮箱'
              }
              return undefined
            },
          },
          { name: 'realName', label: '姓名' },
          {
            name: 'avatar',
            label: '头像',
            render: ({ values, field }) => (
              <ImageUpload
                value={(values.avatar as string | null | undefined) ?? undefined}
                sizeLimit={2}
                className="size-28"
                onChange={(key) => field.handleChange(key)}
              />
            ),
          },
          {
            name: 'password',
            label: '初始密码',
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
      <ModalForm<EditUserForm>
        title="编辑用户"
        open={editDialog.isOpen}
        form={editForm}
        items={[
          {
            name: 'email',
            label: '邮箱',
            disabled: true,
            props: { readOnly: true },
          },
          { name: 'realName', label: '姓名' },
          {
            name: 'avatar',
            label: '头像',
            render: ({ values, field }) => (
              <ImageUpload
                value={(values.avatar as string | null | undefined) ?? undefined}
                sizeLimit={2}
                className="size-28"
                onChange={(key) => field.handleChange(key)}
              />
            ),
          },
          {
            name: 'status',
            label: '状态',
            widget: 'select',
            props: { options: STATUS_OPTIONS },
          },
        ]}
        onCancel={editDialog.close}
      />

      {/* 重置密码 */}
      <ModalForm<ResetPasswordForm>
        title={`重置密码 — ${resetPasswordDialog.data?.email ?? ''}`}
        open={resetPasswordDialog.isOpen}
        form={resetPwdForm}
        submitText="确认重置"
        items={[
          {
            name: 'password',
            label: '新密码',
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
            widget: 'password',
            required: true,
            validate: (value, values) =>
              value !== values.password ? '两次密码不一致' : undefined,
          },
        ]}
        onCancel={resetPasswordDialog.close}
      />
    </div>
  )
}
