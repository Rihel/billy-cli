'use client'

import { useTRPC, useTRPCClient } from '@/lib/trpc'
import {
  ActionType,
  ModalForm,
  ProColumns,
  ProFormDependency,
  ProFormText,
  ProTable,
} from '@ant-design/pro-components'
import { Button, Popconfirm, Space, Tag, message } from 'antd'
import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'

type UserRow = {
  id: string
  email: string
  realName: string | null
  createdAt: string
  updatedAt: string
}

export default function UsersPage() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const actionRef = useRef<ActionType>(null)
  const [editRecord, setEditRecord] = useState<UserRow | null>(null)
  const [resetPwdRecord, setResetPwdRecord] = useState<UserRow | null>(null)

  const removeMutation = useMutation(
    trpc.user.remove.mutationOptions({
      onSuccess() {
        actionRef.current?.reload()
        message.success('删除成功')
      },
    }),
  )

  const columns: ProColumns<UserRow>[] = [
    {
      title: '邮箱',
      dataIndex: 'email',
    },
    {
      title: '姓名',
      dataIndex: 'realName',
      search: false,
      render: (_, { realName }) =>
        realName ? realName : <Tag color="default">未设置</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      search: false,
      width: 180,
      valueType: 'dateTime',
    },
    {
      title: '操作',
      valueType: 'option',
      width: 200,
      render: (_, record) => [
        <a key="edit" onClick={() => setEditRecord(record)}>
          编辑
        </a>,
        <a key="resetPwd" onClick={() => setResetPwdRecord(record)}>
          重置密码
        </a>,
        <Popconfirm
          key="delete"
          title="确认删除该用户？"
          onConfirm={() => removeMutation.mutate({ id: record.id })}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
        >
          <a className="text-red-500">删除</a>
        </Popconfirm>,
      ],
    },
  ]

  return (
    <>
      <ProTable<UserRow>
        actionRef={actionRef}
        rowKey="id"
        headerTitle="用户管理"
        columns={columns}
        request={async ({ pageSize = 10, current = 1, email }) => {
          const res = await trpcClient.user.findMany.query({
            page: current,
            size: pageSize,
            keyword: email || undefined,
            orderBy: 'createdAt',
            order: 'desc',
          })
          return { data: res.items, success: true, total: res.total }
        }}
        toolBarRender={() => [
          <ModalForm
            key="create"
            title="新建用户"
            trigger={<Button type="primary">新建用户</Button>}
            modalProps={{ destroyOnHidden: true }}
            onFinish={async (values) => {
              try {
                await trpcClient.user.create.mutate(
                  values as {
                    email: string
                    password: string
                    realName?: string
                  },
                )
                message.success('创建成功')
                actionRef.current?.reload()
                return true
              } catch (e: any) {
                message.error(e?.message ?? '创建失败')
                return false
              }
            }}
          >
            <ProFormText
              name="email"
              label="邮箱"
              rules={[{ required: true }, { type: 'email' }]}
            />
            <ProFormText name="realName" label="姓名" />
            <ProFormText.Password
              name="password"
              label="初始密码"
              rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}
            />
          </ModalForm>,
        ]}
      />

      {/* 编辑用户 */}
      <ModalForm
        title="编辑用户"
        open={!!editRecord}
        onOpenChange={(open) => !open && setEditRecord(null)}
        initialValues={editRecord ?? undefined}
        modalProps={{ destroyOnHidden: true }}
        onFinish={async (values) => {
          if (!editRecord) return false
          try {
            await trpcClient.user.update.mutate({
              userId: editRecord.id,
              realName: values.realName,
            })
            message.success('更新成功')
            actionRef.current?.reload()
            return true
          } catch (e: any) {
            message.error(e?.message ?? '更新失败')
            return false
          }
        }}
      >
        <ProFormText
          name="email"
          label="邮箱"
          disabled
          fieldProps={{ readOnly: true }}
        />
        <ProFormText name="realName" label="姓名" />
      </ModalForm>

      {/* 重置密码 */}
      <ModalForm
        title={`重置密码 — ${resetPwdRecord?.email}`}
        open={!!resetPwdRecord}
        onOpenChange={(open) => !open && setResetPwdRecord(null)}
        modalProps={{ destroyOnHidden: true }}
        submitter={{ submitButtonProps: { danger: true } }}
        onFinish={async (values) => {
          if (!resetPwdRecord) return false
          try {
            await trpcClient.user.resetPassword.mutate({
              userId: resetPwdRecord.id,
              password: values.password,
            })
            message.success('密码重置成功')
            return true
          } catch (e: any) {
            message.error(e?.message ?? '重置失败')
            return false
          }
        }}
      >
        <ProFormText.Password
          name="password"
          label="新密码"
          rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}
        />
        <ProFormDependency name={['password']}>
          {({ password }) => (
            <ProFormText.Password
              name="confirmPassword"
              label="确认密码"
              rules={[
                { required: true },
                {
                  validator: (_, value) =>
                    !value || password === value
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次密码不一致')),
                },
              ]}
            />
          )}
        </ProFormDependency>
      </ModalForm>
    </>
  )
}
