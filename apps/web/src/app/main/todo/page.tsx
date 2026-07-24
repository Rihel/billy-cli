'use client'

import { useTRPC, useTRPCClient } from '@/lib/client-trpc'
import {
  ActionType,
  ModalForm,
  ProColumns,
  ProFormCheckbox,
  ProFormText,
  ProTable,
} from '@ant-design/pro-components'
import { App, Button, Checkbox, Input, Popconfirm, Space, Tag } from 'antd'
import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'

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
  const actionRef = useRef<ActionType>(null)
  const [editRecord, setEditRecord] = useState<TodoRow | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const createMutation = useMutation(
    trpc.todo.create.mutationOptions({
      onSuccess() {
        actionRef.current?.reload()
        setNewTitle('')
      },
    }),
  )

  const toggleMutation = useMutation(
    trpc.todo.update.mutationOptions({
      onSuccess: () => actionRef.current?.reload(),
    }),
  )

  const removeMutation = useMutation(
    trpc.todo.remove.mutationOptions({
      onSuccess: () => actionRef.current?.reload(),
    }),
  )

  const columns: ProColumns<TodoRow>[] = [
    {
      title: '',
      dataIndex: 'completed',
      search: false,
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
      search: false,
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
      search: false,
      width: 180,
      valueType: 'dateTime',
    },
    {
      title: '操作',
      valueType: 'option',
      width: 100,
      render: (_, record) => [
        <a key="edit" onClick={() => setEditRecord(record)}>
          编辑
        </a>,
        <Popconfirm
          key="delete"
          title="确认删除？"
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
      <ProTable<TodoRow>
        actionRef={actionRef}
        rowKey="id"
        headerTitle="任务管理"
        columns={columns}
        request={async ({ pageSize = 10, current = 1, title }) => {
          const res = await trpcClient.todo.findMany.query({
            page: current,
            size: pageSize,
            keyword: title || undefined,
            orderBy: 'updatedAt',
            order: 'desc',
          })
          return { data: res.items, success: true, total: res.total }
        }}
        toolBarRender={() => [
          <Space.Compact key="quick-add">
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
          </Space.Compact>,
        ]}
      />

      {/* 编辑 Todo */}
      <ModalForm
        title="编辑任务"
        open={!!editRecord}
        onOpenChange={(open) => !open && setEditRecord(null)}
        initialValues={editRecord ?? undefined}
        modalProps={{ destroyOnHidden: true }}
        onFinish={async (values) => {
          if (!editRecord) return false
          try {
            await trpcClient.todo.update.mutate({
              todoId: editRecord.id,
              title: values.title,
              completed: values.completed ?? false,
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
        <ProFormText name="title" label="标题" rules={[{ required: true }]} />
        <ProFormCheckbox name="completed" label="已完成" />
      </ModalForm>
    </>
  )
}
