'use client'

import { formatStorageUrl } from '@/lib/constants'
import { useServerClient } from '@/lib/server-client'
import { EditOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Avatar, Form, Input, Tag } from 'antd'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TableColumnsType } from 'antd'
import {
  ConfirmAction,
  DataTable,
  DisplayValue,
  EmptyValue,
  IconText,
  ImageUpload,
  ModalForm,
  RefreshButton,
  TableActions,
  useDisclosure,
} from '@repo/ui'
import type { SafeUser } from '@repo/sdk'

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
}

type ResetPasswordForm = {
  password: string
  confirmPassword: string
}

export default function UsersPage() {
  const { message } = App.useApp()
  const client = useServerClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const createDialog = useDisclosure()
  const editDialog = useDisclosure<SafeUser>()
  const resetPasswordDialog = useDisclosure<SafeUser>()
  const [createForm] = Form.useForm<CreateUserForm>()
  const [editForm] = Form.useForm<EditUserForm>()
  const [resetPwdForm] = Form.useForm<ResetPasswordForm>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: [
      'user',
      'findMany',
      { page, pageSize, keyword, orderBy: 'createdAt', order: 'desc' },
    ],
    queryFn: () =>
      client.user.pageQuery({
        page,
        size: pageSize,
        keyword,
        orderBy: 'createdAt',
        order: 'desc',
      }),
  })

  const removeMutation = useMutation({
    mutationFn: (input: { userId: string }) => client.user.remove(input),
    onSuccess() {
      refetch()
      message.success('删除成功')
    },
  })

  const columns: TableColumnsType<SafeUser> = [
    {
      title: '头像',
      dataIndex: 'avatar',
      width: 72,
      render: (avatar: string | null) => (
        <Avatar src={avatar ? formatStorageUrl(avatar) : undefined} />
      ),
    },
    {
      title: '邮箱',
      dataIndex: 'email',
    },
    {
      title: '姓名',
      dataIndex: 'realName',
      render: (_, { realName }) => (
        <EmptyValue value={realName} emptyText={<Tag>未设置</Tag>}>
          {realName}
        </EmptyValue>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value) => <DisplayValue type="date" value={value} />,
    },
    {
      title: '操作',
      width: 200,
      render: (_, record) => (
        <TableActions>
          <IconText
            icon={EditOutlined}
            size="small"
            type="primary"
            onClick={() => {
              editForm.setFieldsValue(record)
              editDialog.open(record)
            }}
          >
            编辑
          </IconText>
          <IconText
            icon={LockOutlined}
            size="small"
            type="primary"
            onClick={() => resetPasswordDialog.open(record)}
          >
            重置密码
          </IconText>
          <ConfirmAction
            title="确认删除该用户？"
            onConfirm={() => removeMutation.mutate({ userId: record.id })}
            danger
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  return (
    <div className="w-full h-full bg-white p-5">
      <DataTable<SafeUser>
        title="用户管理"
        toolbar={
          <>
            <RefreshButton
              loading={isFetching}
              onClick={() => void refetch()}
            />
            <Input.Search
              placeholder="搜索邮箱..."
              allowClear
              style={{ width: 200 }}
              onSearch={(v) => {
                setKeyword(v || undefined)
                setPage(1)
              }}
            />
            <IconText
              type="primary"
              icon={PlusOutlined}
              onClick={() => createDialog.open()}
            >
              新建用户
            </IconText>
          </>
        }
        rowKey="id"
        loading={isFetching}
        columns={columns}
        dataSource={data?.items}
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
            formItemProps: {
              rules: [{ required: true }, { type: 'email' }],
            },
          },
          { name: 'realName', label: '姓名' },
          {
            name: 'avatar',
            label: '头像',
            render: () => <ImageUpload sizeLimit={2} className="w-28 h-28" />,
          },
          {
            name: 'password',
            label: '初始密码',
            widget: 'password',
            formItemProps: {
              rules: [{ required: true }, { min: 6, message: '至少 6 位' }],
            },
          },
        ]}
        onCancel={createDialog.close}
        onError={(error) =>
          message.error(error instanceof Error ? error.message : '创建失败')
        }
        onSubmit={async (values) => {
          await client.user.create(values)
          message.success('创建成功')
          refetch()
          createDialog.close()
        }}
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
            render: () => <ImageUpload sizeLimit={2} className="w-28 h-28" />,
          },
        ]}
        onCancel={editDialog.close}
        onError={(error) =>
          message.error(error instanceof Error ? error.message : '更新失败')
        }
        onSubmit={async (values) => {
          if (!editDialog.data) return
          await client.user.update({
            userId: editDialog.data.id,
            realName: values.realName,
            avatar: values.avatar,
          })
          message.success('更新成功')
          refetch()
          editDialog.close()
        }}
      />

      {/* 重置密码 */}
      <ModalForm<ResetPasswordForm>
        title={`重置密码 — ${resetPasswordDialog.data?.email ?? ''}`}
        open={resetPasswordDialog.isOpen}
        form={resetPwdForm}
        items={[
          {
            name: 'password',
            label: '新密码',
            widget: 'password',
            formItemProps: {
              rules: [{ required: true }, { min: 6, message: '至少 6 位' }],
            },
          },
          {
            name: 'confirmPassword',
            label: '确认密码',
            widget: 'password',
            formItemProps: {
              dependencies: ['password'],
              rules: [
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('password') === value)
                      return Promise.resolve()
                    return Promise.reject(new Error('两次密码不一致'))
                  },
                }),
              ],
            },
          },
        ]}
        onCancel={resetPasswordDialog.close}
        modalProps={{ okButtonProps: { danger: true } }}
        onError={(error) =>
          message.error(error instanceof Error ? error.message : '重置失败')
        }
        onSubmit={async (values) => {
          if (!resetPasswordDialog.data) return
          await client.user.resetPassword({
            userId: resetPasswordDialog.data.id,
            password: values.password,
          })
          message.success('密码重置成功')
          resetPasswordDialog.close()
        }}
      />
    </div>
  )
}
