'use client'

import { loginAction } from '@/actions/auth.actions'
import { saveToken } from '@/lib/server-client'
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
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-white font-bold text-xs ring-1 ring-zinc-200 dark:bg-white dark:text-zinc-900 dark:ring-zinc-700">
            B
          </div>
          <span className="text-lg font-semibold tracking-tight">{AppName}</span>
        </div>
      </div>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">欢迎回来</h1>
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
                href="#"
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
