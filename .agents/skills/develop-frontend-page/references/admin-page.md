# Admin 页面模式（develop-frontend-page 引用文件）

> 本文件是 `develop-frontend-page` skill 的组成部分，由主 SKILL.md 引用。
> 写 Admin 后台页面时必读。参考 `apps/admin/src/app/main/system/users/page.tsx`
> 与 `main/todo/page.tsx`。

## 1. 骨架

```tsx
'use client'

import { useServerClient } from '@/lib/server-client'
import { useMutation, useQuery } from '@tanstack/react-query'
import { App, Form, Input } from 'antd'
import { DataTable, ModalForm, useDisclosure, ... } from '@repo/aui'

export default function XxxPage() {
  const { message } = App.useApp()
  const client = useServerClient()
  // 分页状态：page / pageSize / keyword（useState）
  // 弹窗：const dialog = useDisclosure<XxxModel>()
  // 表单：const [form] = Form.useForm<T>()

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['xxx', 'pageQuery', { page, pageSize, keyword }],
    queryFn: () => client.xxx.pageQuery({ page, size: pageSize, keyword, ... }),
  })
  // ...
}
```

## 2. 列表选型

- **页码分页**（管理页默认）：`DataTable<T>`，传 `columns` / `dataSource` / `page` /
  `pageSize` / `total` / `onPageChange`（参考 system/users 页）。
- **游标 / 无限滚动**：`DataList<T>` + `useInfiniteQuery`，`getNextPageParam`
  取 `nextCursor`，数据 `pages.flatMap((r) => r.items)`（参考 todo 页）。
- 操作列：`TableActions` 包裹 `IconText`（编辑）、`ConfirmAction`（删除确认，`danger`）。

## 3. 表单：ModalForm（声明式）

```tsx
<ModalForm<T>
  title="新建 Xxx"
  open={dialog.isOpen}
  form={form}
  items={[
    { name: 'email', label: '邮箱', formItemProps: { rules: [{ required: true }, { type: 'email' }] } },
    { name: 'password', label: '初始密码', widget: 'password', formItemProps: { rules: [{ required: true }, { min: 6 }] } },
    { name: 'status', label: '状态', widget: 'select', props: { options: XxxStatus.options } },
    {
      name: 'avatar', label: '头像',
      // ImageUpload 是受控组件（value/onChange），必须显式接 Form 字段值，否则字段拿不到值
      render: ({ form }) => (
        <ImageUpload
          sizeLimit={2}
          className="w-28 h-28"
          value={form.getFieldValue('avatar')}
          onChange={(key) => form.setFieldValue('avatar', key)}
        />
      ),
    },
  ]}
  onCancel={dialog.close}
  onError={(error) => message.error(error instanceof Error ? error.message : '操作失败')}
  onSubmit={async (values) => { await client.xxx.create(values); message.success('创建成功'); refetch(); dialog.close() }}
/>
```

- `items` 声明式：`name` + `label` + `widget`（`'password'` / `'checkbox'` / `'select'` 等）+
  `props`；复杂表单项用 `render: ({ form, values, disabled }) => <自定义 />`。
  `render` 上下文含 `form` / `values` / `disabled`（见 `packages/aui/src/components/form/FormRenderer.tsx`）。
- **受控组件（如 ImageUpload）必须在 render 里接 `value`/`onChange` 手动同步 Form 字段**。
- 弹窗状态统一 `useDisclosure<T>()`（`open` / `close` / `data`）。
- 编辑场景：`form.setFieldsValue(record)` 预填（users 页的编辑弹窗模式）。

## 4. 数据变更与缓存（增删改后必须同步 UI）

- 简单场景：`useMutation` 成功后 `message.success(...)` + `refetch()`。
- 就地更新（游标列表）：`queryClient.setQueryData(queryKey, (cur) => produce(cur, ...))`，
  用 immer 在 `draft.pages` 上 unshift / splice / Object.assign（todo 页的 prepend/update/remove 模式）。
- 删除确认：`ConfirmAction`；危险操作用 `danger`。

## 5. 展示辅助（@repo/aui）

- `DisplayValue type="date"`（时间格式化）、`DictTag dict={XxxStatus} value={v}`（字典标签）、
  `EmptyValue`（空值占位）、`IconText`（带图标文字按钮）、`RefreshButton`（刷新）、
  `PageToolbar`（页头）、`AutoSize`（自适应高度容器）。
- 存储类：`ImageUpload` / `FileUpload` / `FilePreview` / `StorageProvider`（参考
  `packages/aui/src/components/storage/*`）；文件 key 展示前用 `formatStorageUrl`（`@/lib/constants`）。

## 6. Admin Server Actions（表单提交走 action 时）

```ts
'use server'
// @repo/aui/action 的 defineAction 统一返回 { ok, data } | { ok: false, error }
import { defineAction } from '@repo/aui/action'

export const saveXxxAction = defineAction(async (input: SaveXxxDto) => {
  const client = createServerClient()
  return client.xxx.update(input)
}, { fallbackError: '保存失败' })
```

- `defineAction` / `callAction` 用法见 `packages/aui/src/action.ts`；
  `callAction(action, input, { onSuccess, onError })` 处理结果。
