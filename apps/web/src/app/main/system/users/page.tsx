'use client'

import { useTRPC, useTRPCClient } from '@/lib/client-trpc'
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
} from 'antd'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TableColumnsType } from 'antd'
import dayjs from 'dayjs'

type UserRow = {
  id: string
  email: string
  realName: string | null
  createdAt: string
  updatedAt: string
}

export default function UsersPage() {
  const { message } = App.useApp()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [keyword, setKeyword] = useState<string | undefined>()
  const [createOpen, setCreateOpen] = useState(false)
  const [editRecord, setEditRecord] = useState<UserRow | null>(null)
  const [resetPwdRecord, setResetPwdRecord] = useState<UserRow | null>(null)
  const [createForm] = Form.useForm()
  const [editForm] = Form.useForm()
  const [resetPwdForm] = Form.useForm()

  const { data, isFetching, refetch } = useQuery(
    trpc.user.findMany.queryOptions({
      page,
      size: pageSize,
      keyword,
      orderBy: 'createdAt',
      order: 'desc',
    }),
  )

  const removeMutation = useMutation(
    trpc.user.remove.mutationOptions({
      onSuccess() {
        refetch()
        message.success('删除成功')
      },
    }),
  )

  const columns: TableColumnsType<UserRow> = [
    {
      title: '邮箱',
      dataIndex: 'email',
    },
    {
      title: '姓名',
      dataIndex: 'realName',
      render: (_, { realName }) =>
        realName ? realName : <Tag color="default">未设置</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '操作',
      width: 200,
      render: (_, record) => (
        <Space>
          <a
            onClick={() => {
              setEditRecord(record)
              editForm.setFieldsValue(record)
            }}
          >
            编辑
          </a>
          <a onClick={() => setResetPwdRecord(record)}>重置密码</a>
          <Popconfirm
            title="确认删除该用户？"
            onConfirm={() => removeMutation.mutate({ id: record.id })}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
          >
            <a className="text-red-500">删除</a>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <>
      <div className="flex justify-between items-center mb-4">
        <span className="text-base font-medium">用户管理</span>
        <Space>
          <Input.Search
            placeholder="搜索邮箱..."
            allowClear
            style={{ width: 200 }}
            onSearch={(v) => {
              setKeyword(v || undefined)
              setPage(1)
            }}
          />
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            新建用户
          </Button>
        </Space>
      </div>
      <Table<UserRow>
        rowKey="id"
        loading={isFetching}
        columns={columns}
        dataSource={data?.items}
        pagination={{
          current: page,
          pageSize,
          total: data?.total,
          onChange: (p, ps) => {
            setPage(p)
            setPageSize(ps)
          },
        }}
      />

      {/* 新建用户 */}
      <Modal
        title="新建用户"
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false)
          createForm.resetFields()
        }}
        onOk={() => createForm.submit()}
        destroyOnHidden
      >
        <Form
          form={createForm}
          layout="vertical"
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
              refetch()
              setCreateOpen(false)
              createForm.resetFields()
            } catch (e: any) {
              message.error(e?.message ?? '创建失败')
            }
          }}
        >
          <Form.Item
            name="email"
            label="邮箱"
            rules={[{ required: true }, { type: 'email' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="realName" label="姓名">
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑用户 */}
      <Modal
        title="编辑用户"
        open={!!editRecord}
        onCancel={() => {
          setEditRecord(null)
          editForm.resetFields()
        }}
        onOk={() => editForm.submit()}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={async (values) => {
            if (!editRecord) return
            try {
              await trpcClient.user.update.mutate({
                userId: editRecord.id,
                realName: values.realName,
              })
              message.success('更新成功')
              refetch()
              setEditRecord(null)
              editForm.resetFields()
            } catch (e: any) {
              message.error(e?.message ?? '更新失败')
            }
          }}
        >
          <Form.Item name="email" label="邮箱">
            <Input disabled readOnly />
          </Form.Item>
          <Form.Item name="realName" label="姓名">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      {/* 重置密码 */}
      <Modal
        title={`重置密码 — ${resetPwdRecord?.email}`}
        open={!!resetPwdRecord}
        onCancel={() => {
          setResetPwdRecord(null)
          resetPwdForm.resetFields()
        }}
        onOk={() => resetPwdForm.submit()}
        okButtonProps={{ danger: true }}
        destroyOnHidden
      >
        <Form
          form={resetPwdForm}
          layout="vertical"
          onFinish={async (values) => {
            if (!resetPwdRecord) return
            try {
              await trpcClient.user.resetPassword.mutate({
                userId: resetPwdRecord.id,
                password: values.password,
              })
              message.success('密码重置成功')
              setResetPwdRecord(null)
              resetPwdForm.resetFields()
            } catch (e: any) {
              message.error(e?.message ?? '重置失败')
            }
          }}
        >
          <Form.Item
            name="password"
            label="新密码"
            rules={[{ required: true }, { min: 6, message: '至少 6 位' }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error('两次密码不一致'))
                },
              }),
            ]}
          >
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
