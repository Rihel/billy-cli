'use client'

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import {
  Button,
  DisplayValue,
  EditableInput,
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  ImageUpload,
  Input,
  Skeleton,
  Spinner,
  toastSuccess,
} from '@repo/ui'
import type { AuthUserModel } from '@repo/shared'
import { logoutAction } from '@/actions/auth.actions'
import { Pages } from '@/lib/constants'
import { removeToken, useServerClient } from '@/lib/server-client'

/** 当前用户资料的服务端状态 key（改资料后就地更新，避免多打一次接口） */
const ME_QUERY_KEY = ['auth', 'me'] as const

const EMPTY_PASSWORDS = {
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
}

/**
 * 个人中心：前台唯一的受保护业务页，也是前台**启用 TanStack Query** 的第一个真实用例
 * （此前 web 只挂了 `QueryProvider` 却零 `useQuery`）。
 *
 * 认证凭证说明：浏览器的 `ServerClient` 用登录时写入 localStorage 的 token（`saveToken`），
 * SSR 守卫用 httpOnly cookie —— 两条链路在登录 / 登出时同时写入 / 清理。
 */
export default function AccountPage() {
  const client = useServerClient()
  const router = useRouter()
  const queryClient = useQueryClient()

  const [passwords, setPasswords] = useState(EMPTY_PASSWORDS)
  const [passwordError, setPasswordError] = useState<string>()

  const meQuery = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: () => client.auth.getMe(),
  })

  const updateInfo = useMutation({
    mutationFn: (input: { realName?: string | null; avatar?: string | null }) =>
      client.auth.updateInfo(input),
    onSuccess: (user: AuthUserModel) => {
      queryClient.setQueryData(ME_QUERY_KEY, user)
      toastSuccess('资料已保存')
    },
  })

  const changePassword = useMutation({
    mutationFn: (input: { oldPassword: string; newPassword: string }) =>
      client.auth.changePassword(input),
    onSuccess: async () => {
      // 后端会撤销会话，前端同步清理两条凭证（localStorage + httpOnly cookie）再回登录页
      toastSuccess('密码已修改，请用新密码重新登录')
      await removeToken()
      await logoutAction()
      router.replace(Pages.login)
    },
    onError: (error: unknown) =>
      setPasswordError(
        error instanceof Error ? error.message : '修改失败，请稍后重试',
      ),
  })

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setPasswordError(undefined)

    if (passwords.newPassword.length < 6) {
      setPasswordError('新密码至少 6 位')
      return
    }
    if (passwords.newPassword !== passwords.confirmPassword) {
      setPasswordError('两次输入的新密码不一致')
      return
    }
    changePassword.mutate({
      oldPassword: passwords.oldPassword,
      newPassword: passwords.newPassword,
    })
  }

  const user = meQuery.data

  return (
    <div className="space-y-10">
      <section className="space-y-6 border-b border-zinc-200 pb-10">
        <div>
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            账号资料
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            头像与昵称会展示在你的账号信息中
          </p>
        </div>

        {meQuery.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-40 w-40 rounded-xl" />
            <Skeleton className="h-5 w-56" />
          </div>
        ) : (
          <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
            <ImageUpload
              value={user?.avatar}
              sizeLimit={5}
              disabled={updateInfo.isPending}
              onChange={async (avatar) => {
                await updateInfo.mutateAsync({ avatar })
              }}
            />

            <dl className="flex min-w-0 flex-1 flex-col gap-4 text-sm">
              <div className="flex items-center gap-4">
                <dt className="w-20 shrink-0 text-zinc-500">邮箱</dt>
                <dd className="min-w-0 truncate font-medium">{user?.email}</dd>
              </div>
              <div className="flex items-center gap-4">
                <dt className="w-20 shrink-0 text-zinc-500">昵称</dt>
                <dd className="min-w-0">
                  <EditableInput
                    value={user?.realName ?? null}
                    placeholder="点此设置昵称"
                    onChange={async (realName) => {
                      await updateInfo.mutateAsync({ realName })
                    }}
                  />
                </dd>
              </div>
              <div className="flex items-center gap-4">
                <dt className="w-20 shrink-0 text-zinc-500">注册时间</dt>
                <dd className="font-medium">
                  <DisplayValue type="date" value={user?.createdAt} />
                </dd>
              </div>
            </dl>
          </div>
        )}
      </section>

      <section className="space-y-6">
        <div>
          <h2 className="font-heading text-lg font-semibold tracking-tight">
            修改密码
          </h2>
          <p className="mt-1 text-sm text-zinc-500">
            修改成功后当前会话会失效，需要用新密码重新登录
          </p>
        </div>

        <form onSubmit={submitPassword} className="max-w-sm space-y-5">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="oldPassword">当前密码</FieldLabel>
              <Input
                id="oldPassword"
                type="password"
                autoComplete="current-password"
                value={passwords.oldPassword}
                onChange={(event) =>
                  setPasswords((prev) => ({
                    ...prev,
                    oldPassword: event.target.value,
                  }))
                }
                required
              />
            </Field>

            <Field data-invalid={passwordError ? true : undefined}>
              <FieldLabel htmlFor="newPassword">新密码</FieldLabel>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                value={passwords.newPassword}
                onChange={(event) =>
                  setPasswords((prev) => ({
                    ...prev,
                    newPassword: event.target.value,
                  }))
                }
                required
              />
            </Field>

            <Field data-invalid={passwordError ? true : undefined}>
              <FieldLabel htmlFor="confirmPassword">确认新密码</FieldLabel>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={passwords.confirmPassword}
                onChange={(event) =>
                  setPasswords((prev) => ({
                    ...prev,
                    confirmPassword: event.target.value,
                  }))
                }
                required
              />
            </Field>

            {passwordError ? (
              <FieldError errors={[{ message: passwordError }]} />
            ) : null}

            <Button
              type="submit"
              className="h-10 w-full text-sm font-medium"
              disabled={changePassword.isPending}
            >
              {changePassword.isPending && <Spinner data-icon="inline-start" />}
              确认修改
            </Button>
          </FieldGroup>
        </form>
      </section>
    </div>
  )
}
