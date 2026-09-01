'use client'

import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
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
  Checkbox,
  ConfirmAction,
  cn,
  DataList,
  DisplayValue,
  IconText,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  ModalForm,
  RefreshButton,
  Tag,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import type { DataListApi } from '@repo/ui'

import type {
  AppCursorQueryResponse,
  TodoCursorModel,
  TodoModel,
} from '@repo/shared'
import { PencilIcon, PlusIcon } from 'lucide-react'

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
  const client = useServerClient()
  const queryClient = useQueryClient()
  const editDialog = useDisclosure<TodoModel>()
  const [newTitle, setNewTitle] = useState('')
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
  const completedCount = items.filter((item) => item.completed).length
  const pendingCount = items.length - completedCount
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

  const editForm = useForm({
    defaultValues: { title: '', completed: false },
    onSubmit: async ({ value }) => {
      if (!editDialog.data) return
      const todo = await client.todo.update({
        todoId: editDialog.data.id,
        title: value.title,
        completed: value.completed ?? false,
      })
      updateTodo(todo)
      toastSuccess('更新成功')
      editDialog.close()
    },
  })

  const addTodo = () => {
    const title = newTitle.trim()
    if (!title || createMutation.isPending) return
    createMutation.mutate({ title })
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      {/* 页头：标题 + 统计 + 快捷添加 */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">任务管理</h1>
          {items.length > 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {pendingCount} 项待办 · {completedCount} 项已完成
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted-foreground">
              在上方输入内容，回车即可添加任务
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <RefreshButton
            loading={isFetching && !isFetchingNextPage}
            onClick={() => void resetList()}
          />
          <InputGroup className="w-72">
            <InputGroupInput
              placeholder="添加新任务，回车确认"
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addTodo()
              }}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-sm"
                aria-label="添加任务"
                disabled={!newTitle.trim() || createMutation.isPending}
                onClick={addTodo}
              >
                <PlusIcon />
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      </div>

      {/* 任务列表卡片 */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card shadow-xs">
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
                emptyText="还没有任务，在上方输入创建第一条"
                renderItem={(record) => (
                  <div
                    className={cn(
                      'group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 sm:px-5',
                    )}
                  >
                    <Checkbox
                      checked={record.completed}
                      disabled={toggleMutation.isPending}
                      aria-label="完成状态"
                      className="shrink-0"
                      onCheckedChange={() =>
                        toggleMutation.mutate({
                          todoId: record.id,
                          title: record.title,
                          completed: !record.completed,
                        })
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'truncate text-sm',
                            record.completed
                              ? 'text-muted-foreground line-through'
                              : 'font-medium text-foreground',
                          )}
                        >
                          {record.title}
                        </span>
                        {record.completed ? (
                          <Tag color="success">已完成</Tag>
                        ) : (
                          <Tag color="default">待完成</Tag>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                        {record.description ? (
                          <span className="truncate">{record.description}</span>
                        ) : null}
                        <span>
                          更新于{' '}
                          <DisplayValue type="date" value={record.updatedAt} />
                        </span>
                      </div>
                    </div>

                    {/* 操作：悬停显示，保持列表干净 */}
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <IconText
                        icon={<PencilIcon />}
                        size="small"
                        type="primary"
                        aria-label="编辑"
                        onClick={() => {
                          editForm.reset({
                            title: record.title,
                            completed: record.completed,
                          })
                          editDialog.open(record)
                        }}
                      >
                        编辑
                      </IconText>
                      <ConfirmAction
                        title="确认删除该任务？"
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
      </div>

      <ModalForm<EditTodoForm>
        title="编辑任务"
        open={editDialog.isOpen}
        form={editForm}
        items={[
          {
            name: 'title',
            label: '标题',
            required: true,
          },
          {
            name: 'completed',
            widget: 'checkbox',
            props: { children: '已完成' },
          },
        ]}
        onCancel={editDialog.close}
      />
    </div>
  )
}
