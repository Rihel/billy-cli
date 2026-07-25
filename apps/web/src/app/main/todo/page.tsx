'use client'

import { useTRPC, useTRPCClient } from '@/lib/client-trpc'
import { App, Button, Checkbox, Form, Input, Space, Tag } from 'antd'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { TableColumnsType } from 'antd'
import {
  ConfirmAction,
  DateValue,
  ModalForm,
  PageToolbar,
  PaginationTable,
  TableActions,
  useDisclosure,
} from '@repo/ui'

type TodoRow = {
  id: string
  title: string
  description: string | null
  completed: boolean
  createdAt: string
  updatedAt: string
}

type EditTodoForm = {
  title: string
  completed: boolean
}

export default function TodoPage() {
  const { message } = App.useApp()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const editDialog = useDisclosure<TodoRow>()
  const [newTitle, setNewTitle] = useState('')
  const [editForm] = Form.useForm<EditTodoForm>()

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
      render: (value) => <DateValue value={value} />,
    },
    {
      title: '操作',
      width: 100,
      render: (_, record) => (
        <TableActions>
          <Button
            type="link"
            size="small"
            onClick={() => {
              editForm.setFieldsValue(record)
              editDialog.open(record)
            }}
          >
            编辑
          </Button>
          <ConfirmAction
            title="确认删除？"
            onConfirm={() => removeMutation.mutate({ id: record.id })}
            danger
          >
            删除
          </ConfirmAction>
        </TableActions>
      ),
    },
  ]

  return (
    <>
      <PageToolbar
        title="任务管理"
        extra={
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
        }
      />
      <PaginationTable<TodoRow>
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

      <ModalForm<EditTodoForm>
        title="编辑任务"
        open={editDialog.isOpen}
        form={editForm}
        onCancel={editDialog.close}
        onError={(error) =>
          message.error(error instanceof Error ? error.message : '更新失败')
        }
        onSubmit={async (values) => {
          if (!editDialog.data) return
          await trpcClient.todo.update.mutate({
            todoId: editDialog.data.id,
            title: values.title,
            completed: values.completed ?? false,
          })
          message.success('更新成功')
          refetch()
          editDialog.close()
        }}
      >
        <Form.Item name="title" label="标题" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="completed" valuePropName="checked">
          <Checkbox>已完成</Checkbox>
        </Form.Item>
      </ModalForm>
    </>
  )
}
