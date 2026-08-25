# Web 前台页面模式（develop-frontend-page 引用文件）

> 本文件是 `develop-frontend-page` skill 的组成部分，由主 SKILL.md 引用。
> 写 Web 前台页面时必读。参考 `apps/web/src/app/auth/login/page.tsx` 与
> `apps/web/src/actions/auth.actions.ts`。

## 1. Server Actions（web 侧）

```ts
'use server'

export type ActionResult<T = void> = { success: true; data: T } | { success: false; error: string }

export const xxxAction = wrapAction(async (input: I) => {
  const client = createServerClient()
  return client.xxx.do(input)
})
```

- web 侧用本地 `wrapAction`（`apps/web/src/actions/auth.actions.ts` 的模板），返回
  `{ success, data | error }`；`ApiError` 取 `err.message`，其余兜底文案。
- 涉及会话的操作经 `cookies()` 读写 `TokenKey`（`access-token`，httpOnly cookie，7 天），
  参考 auth.actions.ts 的 `cookieOptions`。

## 2. 页面与表单

- 页面组件用 `@repo/ui`：`Button` / `Input` / `FieldGroup` / `Field` / `FieldLabel` /
  `FieldError` / `Spinner` / `Separator`（参考 login 页）。
- 表单提交用 `useActionState`：
  `const [state, formAction, isPending] = useActionState(handler, init)`，
  失败返回 `{ error }` 展示，成功 `router.replace(目标页)`（`useEffect` 监听 redirect）。
- 客户端数据用 TanStack Query（`QueryProvider` 已全局注入）；查询键规范
  `['domain', 'method', { params }]`。
