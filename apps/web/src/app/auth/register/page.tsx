'use client'

import { registerAction } from '@/actions/auth.actions'
import { saveToken, useServerClient } from '@/lib/server-client'
import { Pages, AppName } from '@/lib/constants'
import { resolveNextPath } from '@/lib/redirect'
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
import { useActionState, useEffect, useState } from 'react'

type RegisterState = {
  error?: string
  redirect?: boolean
}

export default function RegisterPage() {
  const router = useRouter()
  const client = useServerClient()
  // 与登录页一致：注册成功后回跳受保护页（只接受站内相对路径）
  const nextPath = resolveNextPath(useSearchParams().get('next'))
  const [confirmPassword, setConfirmPassword] = useState('')
  const [password, setPassword] = useState('')
  const mismatch = password && confirmPassword && password !== confirmPassword

  // 用户体系开关关闭：注册页无意义，直接回首页
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
        // 获取失败保持现状（显示注册页）
      })
    return () => {
      cancelled = true
    }
  }, [client, router])

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
      if (!result.ok) {
        return { error: result.error }
      }
      await saveToken(result.data.token)
      return { redirect: true }
    },
    {} as RegisterState,
  )

  useEffect(() => {
    if (state.redirect) {
      router.replace(nextPath)
    }
  }, [state.redirect, nextPath, router])

  return (
    <div className="space-y-8">
      {/* Mobile-only branding */}
      <div className="space-y-1.5 lg:hidden">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-violet-600 text-white font-bold text-xs shadow-sm shadow-brand/25 ring-1 ring-brand/30">
            B
          </div>
          <span className="font-heading text-lg font-semibold tracking-tight">{AppName}</span>
        </div>
      </div>

      <div className="space-y-2">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">创建账号</h1>
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
