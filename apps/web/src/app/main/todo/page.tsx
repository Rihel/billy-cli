'use client'

import { useTRPC, useTRPCClient } from '@/lib/client-trpc'
import { EditOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Checkbox, Form, Input, Space, Tag } from 'antd'
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { produce } from 'immer'
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

type TodoCursor = {
  updatedAt: string
  todoId: string
}

type TodoCursorPage = {
  items: TodoRow[]
  nextCursor: TodoCursor | null
}

type TodoListData = InfiniteData<TodoCursorPage, TodoCursor | undefined>

const PAGE_SIZE = 20

export default function TodoPage() {
  const { message } = App.useApp()
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const editDialog = useDisclosure<TodoRow>()
  const [newTitle, setNewTitle] = useState('')
  const [editForm] = Form.useForm<EditTodoForm>()
  const listQueryKey = [
    'todo',
    'findManyCursor',
    'infinite',
    { size: PAGE_SIZE },
  ] as const

  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: listQueryKey,
      initialPageParam: undefined as TodoCursor | undefined,
      queryFn: ({ pageParam }) =>
        trpcClient.todo.findManyCursor.query({
          cursor: pageParam,
          size: PAGE_SIZE,
        }),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    })
  const items = data?.pages.flatMap((result) => result.items) ?? []
  const resetList = () =>
    queryClient.resetQueries({ queryKey: listQueryKey, exact: true })
  const prependTodo = (todo: TodoRow) => {
    queryClient.setQueryData<TodoListData>(listQueryKey, (current) => {
      if (!current) {
        return {
          pages: [
            {
              items: [todo],
              nextCursor: null,
            },
          ],
          pageParams: [undefined],
        }
      }
      return produce(current, (draft) => {
        const firstPage = draft.pages.at(0)
        if (!firstPage) return
        const duplicateIndex = firstPage.items.findIndex(
          (item) => item.id === todo.id,
        )
        if (duplicateIndex >= 0) firstPage.items.splice(duplicateIndex, 1)
        firstPage.items.unshift(todo)
      })
    })
  }
  const updateTodo = (todo: TodoRow) => {
    queryClient.setQueryData<TodoListData>(listQueryKey, (current) => {
      if (!current) return current
      return produce(current, (draft) => {
        const item = draft.pages
          .flatMap((page) => page.items)
          .find((item) => item.id === todo.id)
        if (item) Object.assign(item, todo)
      })
    })
  }
  const removeTodo = (todoId: string) => {
    queryClient.setQueryData<TodoListData>(listQueryKey, (current) => {
      if (!current) return current
      return produce(current, (draft) => {
        for (const page of draft.pages) {
          const index = page.items.findIndex((item) => item.id === todoId)
          if (index >= 0) {
            page.items.splice(index, 1)
            break
          }
        }
      })
    })
  }

  const createMutation = useMutation(
    trpc.todo.create.mutationOptions({
      onSuccess(todo) {
        prependTodo(todo)
        setNewTitle('')
      },
    }),
  )

  const toggleMutation = useMutation(
    trpc.todo.update.mutationOptions({
      onSuccess: updateTodo,
    }),
  )

  const removeMutation = useMutation(
    trpc.todo.remove.mutationOptions({
      onSuccess(todo) {
        removeTodo(todo.id)
      },
    }),
  )

  return (
    <>
      <PageToolbar
        title="任务管理"
        extra={
          <>
            <RefreshButton
              loading={isFetching && !isFetchingNextPage}
              onClick={() => void resetList()}
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
              <IconText
                icon={PlusOutlined}
                type="primary"
                loading={createMutation.isPending}
                onClick={() => {
                  if (newTitle.trim())
                    createMutation.mutate({ title: newTitle.trim() })
                }}
              >
                添加
              </IconText>
            </Space.Compact>
          </>
        }
      />

      <DataList<TodoRow>
        rowKey="id"
        loading={isFetching && !data}
        loadingMore={isFetchingNextPage}
        hasMore={hasNextPage}
        onLoadMore={async () => {
          await fetchNextPage()
        }}
        dataSource={items}
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
                onConfirm={() => removeMutation.mutate({ todoId: record.id })}
                danger
              >
                删除
              </ConfirmAction>
            </Space>
          </div>
        )}
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
          const todo = await trpcClient.todo.update.mutate({
            todoId: editDialog.data.id,
            title: values.title,
            completed: values.completed ?? false,
          })
          updateTodo(todo)
          message.success('更新成功')
          editDialog.close()
        }}
      />
    </>
  )
}
