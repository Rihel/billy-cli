'use client'

import { getServerClient, removeToken, saveToken } from '@/lib/server-client'
import { checkSessionAction, loginAction, logoutAction } from '@/actions/auth.actions'
import {
  Alert,
  AlertDescription,
  Button,
  FormRenderer,
  Spinner,
  toastError,
  toastSuccess,
} from '@repo/ui'
import { callAction } from '@repo/ui/action'
import { useForm } from '@tanstack/react-form'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { Pages } from '@/lib/constants'
import { LogInIcon } from 'lucide-react'

type LoginForm = {
  email: string
  password: string
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function LoginFormComponent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [checking, setChecking] = useState(true)

  // 从 ?reason=expired 判断是否为会话过期后跳回
  const expired = searchParams.get('reason') === 'expired'

  // 用户体系开关关闭：无需登录，直接进入主界面
  useEffect(() => {
    let cancelled = false
    const client = getServerClient()
    client.config
      .get()
      .then((config) => {
        if (cancelled) return
        // 同步到业务请求所用 client 实例：关闭时跳过前端凭证校验，交由后端守卫判断
        client.setAuthEnabled(config.authEnabled)
        if (!config.authEnabled) {
          router.replace(Pages.dashboard)
        }
      })
      .catch(() => {
        // 获取失败保持默认（显示登录页）
      })
    return () => {
      cancelled = true
    }
  }, [router])

  // 挂载时探测会话：有效 token → 直接进入主界面；失效 token → 清理 cookie，避免循环跳转
  useEffect(() => {
    let cancelled = false
    void callAction(checkSessionAction, undefined, {
      onSuccess: (ok) => {
        if (cancelled) return
        if (ok) {
          router.replace(Pages.dashboard)
          return
        }
        setChecking(false)
      },
      onError: async () => {
        if (cancelled) return
        await logoutAction()
        await removeToken()
        setChecking(false)
      },
    })
    return () => {
      cancelled = true
    }
  }, [router])

  const form = useForm({
    defaultValues: { email: '', password: '' },
    onSubmit: async ({ value }) => {
      await callAction(loginAction, value, {
        onError: (error) => {
          toastError(error)
        },
        onSuccess: (token) => {
          void saveToken(token)
          toastSuccess('登录成功')
          router.replace(Pages.dashboard)
        },
      })
    },
  })

  if (checking) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spinner className="size-8" />
      </div>
    )
  }

  return (
    <>
      <div className="mb-8 flex flex-col gap-1.5">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">登录控制台</h1>
        <p className="text-sm text-muted-foreground">输入你的管理员凭据继续</p>
      </div>
      {expired ? (
        <Alert className="mb-4">
          <AlertDescription>登录已过期，请重新登录</AlertDescription>
        </Alert>
      ) : null}
      <FormRenderer<LoginForm>
        form={form}
        items={[
          {
            name: 'email',
            label: '邮箱',
            required: true,
            validate: (value) => {
              if (typeof value === 'string' && value && !EMAIL_PATTERN.test(value)) {
                return '请输入有效邮箱'
              }
              return undefined
            },
            props: {
              placeholder: '请输入邮箱',
              autoComplete: 'email',
            },
          },
          {
            name: 'password',
            label: '密码',
            widget: 'password',
            required: true,
            props: {
              placeholder: '请输入密码',
              autoComplete: 'current-password',
            },
          },
        ]}
      >
        <Button type="submit" size="lg" className="w-full">
          <LogInIcon />
          登录
        </Button>
      </FormRenderer>
    </>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-24">
          <Spinner className="size-8" />
        </div>
      }
    >
      <LoginFormComponent />
    </Suspense>
  )
}
