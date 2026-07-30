'use client'

import { registerAction } from '@/actions/auth.actions'
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
import { useActionState, useEffect, useState } from 'react'

type RegisterState = {
  error?: string
  redirect?: boolean
}

export default function RegisterPage() {
  const router = useRouter()
  const [confirmPassword, setConfirmPassword] = useState('')
  const [password, setPassword] = useState('')
  const mismatch = password && confirmPassword && password !== confirmPassword

  const [state, formAction, isPending] = useActionState(
    async (_prev: RegisterState, formData: FormData) => {
      const pw = formData.get('password') as string
      const cp = formData.get('confirmPassword') as string
      if (pw !== cp) {
        return { error: '两次输入的密码不一致' }
      }
      const result = await registerAction({
        email: formData.get('email') as string,
        password: pw,
        realName: (formData.get('realName') as string) || undefined,
      })
      if (!result.success) {
        return { error: result.error }
      }
      await saveToken(result.data.token)
      return { redirect: true }
    },
    {} as RegisterState,
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
        <h1 className="text-2xl font-semibold tracking-tight">创建账号</h1>
        <p className="text-sm text-muted-foreground">
          填写以下信息注册新账号
        </p>
      </div>

      <form action={formAction} className="space-y-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="email">邮箱</FieldLabel>
            <Input
              id="email"
              name="email"
              type="email"
              placeholder="name@example.com"
              autoComplete="email"
              required
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="realName">姓名</FieldLabel>
            <Input
              id="realName"
              name="realName"
              type="text"
              placeholder="你的真实姓名（可选）"
              autoComplete="name"
            />
          </Field>

          <Field data-invalid={!!mismatch || undefined}>
            <FieldLabel htmlFor="password">密码</FieldLabel>
            <Input
              id="password"
              name="password"
              type="password"
              placeholder="至少 6 位字符"
              autoComplete="new-password"
              required
              minLength={6}
              aria-invalid={!!mismatch || undefined}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>

          <Field data-invalid={!!mismatch || undefined}>
            <FieldLabel htmlFor="confirmPassword">确认密码</FieldLabel>
            <Input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              placeholder="再次输入密码"
              autoComplete="new-password"
              required
              aria-invalid={!!mismatch || undefined}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>

          {mismatch && (
            <FieldError errors={[{ message: '两次输入的密码不一致' }]} />
          )}
          {state.error && !mismatch && (
            <FieldError errors={[{ message: state.error }]} />
          )}

          <Button
            type="submit"
            className="w-full h-10 text-sm font-medium tracking-wide"
            disabled={isPending}
          >
            {isPending && <Spinner data-icon="inline-start" />}
            注册
          </Button>
        </FieldGroup>
      </form>

      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">或者</span>
        <Separator className="flex-1" />
      </div>

      <p className="text-center text-sm text-muted-foreground">
        已有账号？{' '}
        <Link
          href={Pages.login}
          className="font-medium text-foreground underline underline-offset-4 hover:opacity-80 transition-opacity"
        >
          去登录
        </Link>
      </p>
    </div>
  )
}
