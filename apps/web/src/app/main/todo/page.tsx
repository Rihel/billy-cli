'use client'

import { useTRPC, useTRPCClient } from '@/lib/client-trpc'
import {
  App,
  Button,
  Checkbox,
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

type TodoRow = {
  id: string
  title: string
  description: string | null
  completed: boolean
  createdAt: string
  updatedAt: string
}

export default function TodoPage() {
  const { message } = App.useApp()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [editRecord, setEditRecord] = useState<TodoRow | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [editForm] = Form.useForm()

  const { data, isFetching, refetch } = useQuery(
    trpc.todo.findMany.queryOptions({
      page,
      size: pageSize,
      orderBy: 'updatedAt',
      order: 'desc',
    }),
  )

  const createMutation = useMutation(
    trpc.todo.create.mutationOptions({
      onSuccess() {
        refetch()
        setNewTitle('')
      },
    }),
  )

  const toggleMutation = useMutation(
    trpc.todo.update.mutationOptions({
      onSuccess: () => refetch(),
    }),
  )

  const removeMutation = useMutation(
    trpc.todo.remove.mutationOptions({
      onSuccess: () => refetch(),
    }),
  )

  const columns: TableColumnsType<TodoRow> = [
    {
      title: '',
      dataIndex: 'completed',
      width: 48,
      render: (_, record) => (
        <Checkbox
          checked={record.completed}
          onChange={() =>
            toggleMutation.mutate({
              todoId: record.id,
              title: record.title,
              completed: !record.completed,
            })
          }
        />
      ),
    },
    {
      title: '标题',
      dataIndex: 'title',
      render: (_, { title, completed }) => (
        <span
          style={{
            textDecoration: completed ? 'line-through' : 'none',
            color: completed ? '#999' : undefined,
          }}
        >
          {title}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'completed',
      width: 80,
      render: (_, { completed }) =>
        completed ? (
          <Tag color="success">已完成</Tag>
        ) : (
          <Tag color="default">待完成</Tag>
        ),
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 180,
      render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: '操作',
      width: 100,
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
          <Popconfirm
            title="确认删除？"
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
        <span className="text-base font-medium">任务管理</span>
        <Space.Compact>
          <Input
            placeholder="快速添加任务..."
            value={newTitle}
            style={{ width: 240 }}
            onChange={(e) => setNewTitle(e.target.value)}
            onPressEnter={() => {
              if (newTitle.trim())
                createMutation.mutate({ title: newTitle.trim() })
            }}
          />
          <Button
            type="primary"
            loading={createMutation.isPending}
            onClick={() => {
              if (newTitle.trim())
                createMutation.mutate({ title: newTitle.trim() })
            }}
          >
            添加
          </Button>
        </Space.Compact>
      </div>
      <Table<TodoRow>
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

      <Modal
        title="编辑任务"
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
              await trpcClient.todo.update.mutate({
                todoId: editRecord.id,
                title: values.title,
                completed: values.completed ?? false,
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
          <Form.Item name="title" label="标题" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="completed" valuePropName="checked">
            <Checkbox>已完成</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
