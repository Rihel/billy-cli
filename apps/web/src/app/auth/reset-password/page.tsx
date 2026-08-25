'use client'

import { resetPasswordAction } from '@/actions/auth.actions'
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
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useActionState, useEffect, useState } from 'react'

type ResetPasswordState = {
  error?: string
  success?: boolean
}

function ResetPasswordInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const tokenFromUrl = searchParams.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const mismatch = password && confirmPassword && password !== confirmPassword

  const [state, formAction, isPending] = useActionState(
    async (_prev: ResetPasswordState, formData: FormData) => {
      const pw = formData.get('password') as string
      const cp = formData.get('confirmPassword') as string
      if (pw !== cp) {
        return { error: '两次输入的密码不一致' }
      }
      const tk = tokenFromUrl || (formData.get('token') as string) || ''
      if (!tk) {
        return { error: '缺少重置令牌，请从邮箱中的链接进入' }
      }
      const result = await resetPasswordAction({ token: tk, password: pw })
      if (!result.success) {
        return { error: result.error }
      }
      return { success: true }
    },
    {} as ResetPasswordState,
  )

  useEffect(() => {
    if (state.success) {
      router.replace(Pages.login)
    }
  }, [state.success, router])

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
        <h1 className="text-2xl font-semibold tracking-tight">重置密码</h1>
        <p className="text-sm text-muted-foreground">请设置你的新密码</p>
      </div>

      <form action={formAction} className="space-y-5">
        <input type="hidden" name="token" value={tokenFromUrl} />
        <FieldGroup>
          <Field data-invalid={!!mismatch || undefined}>
            <FieldLabel htmlFor="password">新密码</FieldLabel>
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
            <FieldLabel htmlFor="confirmPassword">确认新密码</FieldLabel>
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
            确认重置
          </Button>
        </FieldGroup>
      </form>

      <div className="flex items-center gap-3">
        <Separator className="flex-1" />
        <span className="text-xs text-muted-foreground">或者</span>
        <Separator className="flex-1" />
      </div>

      <p className="text-center text-sm text-muted-foreground">
        想起密码了？{' '}
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

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  )
}
