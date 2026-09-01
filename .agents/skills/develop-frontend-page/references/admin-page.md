# Admin 页面模式（develop-frontend-page 引用文件）

> 本文件是 `develop-frontend-page` skill 的组成部分，由主 SKILL.md 引用。
> 写 Admin 后台页面时必读。参考 `apps/admin/src/app/main/system/users/page.tsx`
> 与 `main/todo/page.tsx`。

## 1. 骨架

```tsx
'use client'

import { useServerClient } from '@/lib/server-client'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery } from '@tanstack/react-query'
import { DataTable, ModalForm, useDisclosure, ... } from '@repo/ui'

export default function XxxPage() {
  const client = useServerClient()
  // 分页状态：page / pageSize / keyword（useState）
  // 弹窗：const dialog = useDisclosure<XxxModel>()
  // 表单：const form = useForm({ defaultValues: {...}, onSubmit: async ({ value }) => {...} })

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['xxx', 'pageQuery', { page, pageSize, keyword }],
    queryFn: () => client.xxx.pageQuery({ page, size: pageSize, keyword, ... }),
  })
  // ...
}
```

## 2. 列表选型（@tanstack/react-table）

- **页码分页**（管理页默认）：`DataTable<T>`，传 `columns` / `data` / `page` /
  `pageSize` / `total` / `onPageChange`（参考 system/users 页）。
  列定义用 `DataTableColumnDef<T>`：`header` + `accessorKey` + `cell: ({ row, getValue })`，
  列宽用 `meta: { width }`。
- **游标 / 无限滚动**：`DataList<T>` + `useInfiniteQuery`，`getNextPageParam`
  取 `nextCursor`，数据 `pages.flatMap((r) => r.items)`（参考 todo 页）。
- 操作列：`TableActions` 包裹 `IconText`（编辑）、`ConfirmAction`（删除确认，`danger`）。

## 3. 表单：@tanstack/react-form（声明式）

表单实例在页面用 `useForm` 创建，**onSubmit 写在 useForm 里**（提交成功后自己
`toastSuccess` + 关闭弹窗 + `refetch`）；`ModalForm` / `DrawerForm` / `FormRenderer`
只负责渲染与提交触发。不要给 `useForm` 写显式泛型（本版本需 12 个类型参数），
用 `defaultValues` 推断；类型不一致时给 `defaultValues` 加 `as XxxForm` 断言。

```tsx
const dialog = useDisclosure()
const form = useForm({
  defaultValues: { email: '', password: '' } as CreateXxxForm,
  onSubmit: async ({ value }) => {
    await client.xxx.create(value)
    toastSuccess('创建成功')
    refetch()
    dialog.close()
  },
})

<ModalForm<CreateXxxForm>
  title="新建 Xxx"
  open={dialog.isOpen}
  form={form}
  items={[
    { name: 'email', label: '邮箱', required: true, validate: (v) => (v && !EMAIL_PATTERN.test(String(v))) ? '请输入有效邮箱' : undefined },
    { name: 'password', label: '初始密码', widget: 'password', required: true, validate: (v) => (typeof v === 'string' && v.length > 0 && v.length < 6) ? '至少 6 位' : undefined },
    { name: 'status', label: '状态', widget: 'select', props: { options: [{ label: '启用', value: 'enabled' }, { label: '禁用', value: 'disabled' }] } },
    {
      name: 'avatar', label: '头像',
      // 受控组件（ImageUpload 等）必须在 render 里手动接 value / onChange
      render: ({ values, field }) => (
        <ImageUpload
          sizeLimit={2}
          className="size-28"
          value={(values.avatar as string | null | undefined) ?? undefined}
          onChange={(key) => field.handleChange(key)}
        />
      ),
    },
  ]}
  onCancel={dialog.close}
/>
```

- `items` 声明式：`name` + `label` + `widget`（`'input'` / `'password'` / `'textarea'` /
  `'number'` / `'select'` / `'radio'` / `'checkbox'` / `'switch'` / `'date'`）+ `props`
  （`select` 用 `options` + `multiple`）；复杂表单项用 `render: ({ form, field, values, disabled })`。
- 校验：`required: true | '错误文案'`（必填）+ `validate: (value, values) => string | undefined`
  （自定义校验，可用 `values` 做跨字段判断，如两次密码一致）。
- 弹窗状态统一 `useDisclosure<T>()`（`open` / `close` / `data`）。
- 编辑场景：`form.reset(record)` 预填（users 页的编辑弹窗模式）；
  关闭时 `ModalForm` 自动 `form.reset()` 回到默认值。
- 字段多 / 需说明文案用 `DrawerForm`（`description` prop 放说明区，参考 monitor/rules 页）。

## 4. 数据变更与缓存（增删改后必须同步 UI）

- 简单场景：`useMutation` 成功后 `toastSuccess(...)` + `refetch()`。
- 就地更新（游标列表）：`queryClient.setQueryData(queryKey, (cur) => produce(cur, ...))`，
  用 immer 在 `draft.pages` 上 unshift / splice / Object.assign（todo 页的 prepend/update/remove 模式）。
- 删除确认：`ConfirmAction`；危险操作用 `danger`。

## 5. 展示辅助（@repo/ui）

- `DisplayValue type="date"`（时间格式化）、`DictTag dict={XxxStatus} value={v}`（字典标签）、
  `EmptyValue`（空值占位）、`Tag color="blue|green|red|..."`（常见预设色名）、`IconText`
  （带图标文字按钮）、`RefreshButton`（刷新）、`PageToolbar`（页头）、`AutoSize`（自适应高度容器）。
- 存储类：`ImageUpload` / `FileUpload` / `FilePreview` / `StorageProvider`（参考
  `packages/ui/src/components/*`）；文件 key 展示前用 `formatStorageUrl`（`@/lib/constants`）。
- 反馈：`toastSuccess` / `toastError` / `toastWarning`（`@repo/ui`，Toaster 已在根布局挂载）；
  全局 QueryClient 的错误已自动 toast，无需逐处 `message.error`。

## 6. Admin Server Actions（表单提交走 action 时）

```ts
'use server'
// @repo/ui/action 的 defineAction 统一返回 { ok, data } | { ok: false, error }
import { defineAction } from '@repo/ui/action'

export const saveXxxAction = defineAction(async (input: SaveXxxDto) => {
  const client = createServerClient()
  return client.xxx.update(input)
}, { fallbackError: '保存失败' })
```

- `defineAction` / `callAction` 用法见 `packages/ui/src/action.ts`；
  `callAction(action, input, { onSuccess, onError })` 处理结果。
