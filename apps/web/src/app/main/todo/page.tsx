'use client'

import { useTRPC, useTRPCClient } from '@/lib/client-trpc'
import { EditOutlined } from '@ant-design/icons'
import {
  App,
  Button,
  Checkbox,
  Form,
  Input,
  Pagination,
  Space,
  Tag,
} from 'antd'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  ConfirmAction,
  DataList,
  DisplayValue,
  IconText,
  ModalForm,
  PageToolbar,
  RefreshButton,
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

  return (
    <>
      <PageToolbar
        title="任务管理"
        extra={
          <>
            <RefreshButton
              loading={isFetching}
              onClick={() => void refetch()}
            />
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
          </>
        }
      />

      <DataList<TodoRow>
        rowKey="id"
        loading={isFetching}
        dataSource={data?.items}
        height="calc(100vh - 270px)"
        listClassName="border-y border-gray-200"
        renderItem={(record) => (
          <div className="flex min-h-20 items-center gap-3 border-b border-gray-100 px-3 py-3 last:border-b-0">
            <Checkbox
              checked={record.completed}
              disabled={toggleMutation.isPending}
              onChange={() =>
                toggleMutation.mutate({
                  todoId: record.id,
                  title: record.title,
                  completed: !record.completed,
                })
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={
                    record.completed
                      ? 'text-gray-400 line-through'
                      : 'text-gray-900'
                  }
                >
                  {record.title}
                </span>
                <Tag color={record.completed ? 'success' : 'default'}>
                  {record.completed ? '已完成' : '待完成'}
                </Tag>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                {record.description ? (
                  <span className="truncate">{record.description}</span>
                ) : null}
                <span>
                  更新于 <DisplayValue type="date" value={record.updatedAt} />
                </span>
              </div>
            </div>
            <Space size={4} wrap>
              <IconText
                icon={EditOutlined}
                size="small"
                onClick={() => {
                  editForm.setFieldsValue(record)
                  editDialog.open(record)
                }}
              >
                编辑
              </IconText>
              <ConfirmAction
                title="确认删除？"
                onConfirm={() => removeMutation.mutate({ id: record.id })}
                danger
              >
                删除
              </ConfirmAction>
            </Space>
          </div>
        )}
        footer={
          <div className="flex justify-end">
            <Pagination
              current={page}
              pageSize={pageSize}
              total={data?.total}
              showSizeChanger
              showTotal={(total) => `共 ${total} 项`}
              onChange={(nextPage, nextPageSize) => {
                setPage(nextPageSize === pageSize ? nextPage : 1)
                setPageSize(nextPageSize)
              }}
            />
          </div>
        }
      />

      <ModalForm<EditTodoForm>
        title="编辑任务"
        open={editDialog.isOpen}
        form={editForm}
        items={[
          {
            name: 'title',
            label: '标题',
            formItemProps: { rules: [{ required: true }] },
          },
          {
            name: 'completed',
            widget: 'checkbox',
            props: { children: '已完成' },
          },
        ]}
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
      />
    </>
  )
}
