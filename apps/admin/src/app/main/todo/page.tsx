'use client'

import { useServerClient } from '@/lib/server-client'
import { EditOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Checkbox, Form, Input, Space, Tag } from 'antd'
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { InfiniteData } from '@tanstack/react-query'
import { produce } from 'immer'
import { useRef, useState } from 'react'
import {
  AutoSize,
  ConfirmAction,
  DataList,
  DataListApi,
  DisplayValue,
  IconText,
  ModalForm,
  PageToolbar,
  RefreshButton,
  useDisclosure,
} from '@repo/aui'

import type {
  AppCursorQueryResponse,
  TodoCursorModel,
  TodoModel,
} from '@repo/shared'

type EditTodoForm = {
  title: string
  completed: boolean
}

type TodoListData = InfiniteData<
  AppCursorQueryResponse<TodoModel, TodoCursorModel>,
  TodoCursorModel | undefined
>

const PAGE_SIZE = 20

export default function TodoPage() {
  const { message } = App.useApp()
  const client = useServerClient()
  const queryClient = useQueryClient()
  const editDialog = useDisclosure<TodoModel>()
  const [newTitle, setNewTitle] = useState('')
  const [editForm] = Form.useForm<EditTodoForm>()
  const listRef = useRef<DataListApi>(null)
  const listQueryKey = ['todo', 'cursorQuery', { size: PAGE_SIZE }] as const

  const { data, fetchNextPage, hasNextPage, isFetching, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: listQueryKey,
      initialPageParam: undefined as TodoCursorModel | undefined,
      queryFn: ({ pageParam }) =>
        client.todo.cursorQuery({
          cursor: pageParam,
          size: PAGE_SIZE,
        }),
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    })
  const items = data?.pages.flatMap((result) => result.items) ?? []
  const resetList = () =>
    queryClient.resetQueries({ queryKey: listQueryKey, exact: true })
  const prependTodo = (todo: TodoModel) => {
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
  const updateTodo = (todo: TodoModel) => {
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

  const createMutation = useMutation({
    mutationFn: (input: { title: string }) => client.todo.create(input),
    onSuccess(todo) {
      prependTodo(todo)
      setNewTitle('')
      listRef.current?.scrollToTop()
    },
  })

  const toggleMutation = useMutation({
    mutationFn: (input: {
      todoId: string
      title: string
      completed: boolean
    }) => client.todo.update(input),
    onSuccess: updateTodo,
  })

  const removeMutation = useMutation({
    mutationFn: (input: { todoId: string }) => client.todo.remove(input),
    onSuccess(todo) {
      removeTodo(todo.id)
    },
  })

  return (
    <div className="bg-white h-full gap-4">
      <PageToolbar
        title="任务管理"
        className="p-4"
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

      <AutoSize>
        {({ height }) => {
          return (
            <DataList<TodoModel>
              ref={listRef}
              rowKey="id"
              loading={isFetching && !data}
              loadingMore={isFetchingNextPage}
              hasMore={hasNextPage}
              onLoadMore={async () => {
                await fetchNextPage()
              }}
              dataSource={items}
              height={height}
              listClassName="border-y border-gray-200"
              renderItem={(record) => (
                <div className="flex min-h-20 items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0">
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
                        更新于{' '}
                        <DisplayValue type="date" value={record.updatedAt} />
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
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
                    <ConfirmAction
                      title="确认删除？"
                      onConfirm={() =>
                        removeMutation.mutate({ todoId: record.id })
                      }
                      danger
                    >
                      删除
                    </ConfirmAction>
                  </div>
                </div>
              )}
            />
          )
        }}
      </AutoSize>

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
          const todo = await client.todo.update({
            todoId: editDialog.data.id,
            title: values.title,
            completed: values.completed ?? false,
          })
          updateTodo(todo)
          message.success('更新成功')
          editDialog.close()
        }}
      />
    </div>
  )
}
