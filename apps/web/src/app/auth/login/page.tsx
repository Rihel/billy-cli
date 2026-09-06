'use client'

import { loginAction } from '@/actions/auth.actions'
import { saveToken, useServerClient } from '@/lib/server-client'
import { Pages, AppName } from '@/lib/constants'
import {
  Button,
  Input,
  FieldGroup,
  Field,
  FieldLabel,
  FieldError,
  Spinner,
  Separator,
} from '@repo/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useActionState, useEffect } from 'react'

type LoginState = {
  error?: string
  redirect?: boolean
}

export default function LoginPage() {
  const router = useRouter()
  const client = useServerClient()

  // 用户体系开关关闭：登录页无意义，直接回首页
  useEffect(() => {
    let cancelled = false
    client.config
      .get()
      .then((config) => {
        if (cancelled) return
        client.setAuthEnabled(config.authEnabled)
        if (!config.authEnabled) {
          router.replace(Pages.home)
        }
      })
      .catch(() => {
        // 获取失败保持现状（显示登录页）
      })
    return () => {
      cancelled = true
    }
  }, [client, router])

  const [state, formAction, isPending] = useActionState(
    async (_prev: LoginState, formData: FormData) => {
      const result = await loginAction({
        email: formData.get('email') as string,
        password: formData.get('password') as string,
      })
      if (!result.success) {
        return { error: result.error }
      }
      await saveToken(result.data.token)
      return { redirect: true }
    },
    {} as LoginState,
  )

  useEffect(() => {
    if (state.redirect) {
      router.replace(Pages.home)
    }
  }, [state.redirect, router])

  return (
    <div className="space-y-8">
      {/* Mobile-only branding */}
      <div className="space-y-1.5 lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white font-bold text-xs shadow-sm shadow-indigo-600/25 ring-1 ring-indigo-200/60">
            B
          </div>
          <span className="font-heading text-lg font-semibold tracking-tight">{AppName}</span>
        </div>
      </div>

      <div className="space-y-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">欢迎回来</h1>
        <p className="text-sm text-muted-foreground">
          请输入你的邮箱和密码登录账号
        </p>
      </div>

      <form action={formAction} className="space-y-5">
        <FieldGroup>
          <Field data-invalid={!!state.error || undefined}>
            <FieldLabel htmlFor="email">邮箱</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="name@example.com"
              autoComplete="email"
              required
              aria-invalid={!!state.error || undefined}
            />
          </Field>

          <Field data-invalid={!!state.error || undefined}>
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor="password">密码</FieldLabel>
              <Link
                href={Pages.forgotPassword}
                className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                忘记密码？
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="········"
              autoComplete="current-password"
              required
              aria-invalid={!!state.error || undefined}
            />
          </Field>

          {state.error && (
            <FieldError errors={[{ message: state.error }]} />
          )}

          <Button
            type="submit"
            className="w-full h-10 text-sm font-medium tracking-wide"
            disabled={isPending}
          >
            {isPending && <Spinner data-icon="inline-start" />}
            登录
          </Button>
        </FieldGroup>
      </form>

      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">或者</span>
        <Separator className="flex-1" />
      </div>

      <p className="text-center text-sm text-muted-foreground">
        还没有账号？{' '}
        <Link
          href={Pages.register}
          className="font-medium text-foreground underline underline-offset-4 hover:opacity-80 transition-opacity"
        >
          创建账号
        </Link>
      </p>
    </div>
  )
}
