'use client'

import { forgotPasswordAction } from '@/actions/auth.actions'
import { useServerClient } from '@/lib/server-client'
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

type ForgotPasswordState = {
  error?: string
  sent?: boolean
}

export default function ForgotPasswordPage() {
  const router = useRouter()
  const client = useServerClient()

  // 用户体系开关关闭：找回密码页无意义，直接回首页
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
        // 获取失败保持现状（显示找回密码页）
      })
    return () => {
      cancelled = true
    }
  }, [client, router])

  const [state, formAction, isPending] = useActionState(
    async (_prev: ForgotPasswordState, formData: FormData) => {
      const result = await forgotPasswordAction({
        email: formData.get('email') as string,
      })
      if (!result.ok) {
        return { error: result.error }
      }
      // 令牌只经邮件投递，响应体不含任何凭据；这里只确认「请求已受理」
      return { sent: true }
    },
    {} as ForgotPasswordState,
  )

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
        <h1 className="font-heading text-2xl font-semibold tracking-tight">找回密码</h1>
        <p className="text-sm text-muted-foreground">输入注册邮箱，我们会把重置链接发到你的邮箱</p>
      </div>

      {state.sent ? (
        <div className="space-y-3 rounded-lg border bg-surface-1 p-4 text-sm">
          <p className="font-medium">请求已受理</p>
          <p className="text-muted-foreground">
            如果该邮箱已注册，重置链接已发送到邮箱，请在有效期内完成重置。没收到请检查垃圾邮件，
            或稍后重试。
          </p>
        </div>
      ) : (
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

            {state.error && <FieldError errors={[{ message: state.error }]} />}

            <Button
              type="submit"
              className="w-full h-10 text-sm font-medium tracking-wide"
              disabled={isPending}
            >
              {isPending && <Spinner data-icon="inline-start" />}
              发送重置链接
            </Button>
          </FieldGroup>
        </form>
      )}

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
