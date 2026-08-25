'use client'

import { removeToken, saveToken } from '@/lib/server-client'
import {
  checkSessionAction,
  loginAction,
  logoutAction,
} from '@/actions/auth.actions'
import { LoginOutlined } from '@ant-design/icons'
import { FormRenderer } from '@repo/aui'
import { callAction } from '@repo/aui/action'
import { Alert, App, Button, Form, Spin, Typography } from 'antd'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { AppName, Pages } from '@/lib/constants'

type LoginForm = {
  email: string
  password: string
}

function LoginForm() {
  const { message } = App.useApp()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [form] = Form.useForm<LoginForm>()
  const [checking, setChecking] = useState(true)

  // 从 ?reason=expired 判断是否为会话过期后跳回
  const expired = searchParams.get('reason') === 'expired'

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

  if (checking) {
    return (
      <div className="flex items-center justify-center py-24">
        <Spin size="large" />
      </div>
    )
  }

  return (
    <>
      <div className="text-center mb-6">
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {AppName}
        </Typography.Title>
        <Typography.Text type="secondary">欢迎登录</Typography.Text>
      </div>
      {expired ? (
        <Alert
          type="warning"
          showIcon
          message="登录已过期，请重新登录"
          className="mb-4"
        />
      ) : null}
      <FormRenderer<LoginForm>
        form={form}
        items={[
          {
            name: 'email',
            formItemProps: {
              rules: [
                { required: true },
                { type: 'email', message: '请输入有效邮箱' },
              ],
            },
            props: {
              size: 'large',
              placeholder: '请输入邮箱',
              autoComplete: 'email',
            },
          },
          {
            name: 'password',
            widget: 'password',
            formItemProps: { rules: [{ required: true }] },
            props: {
              size: 'large',
              placeholder: '请输入密码',
              autoComplete: 'current-password',
            },
          },
        ]}
        formProps={{
          onFinish: async (values) => {
            await callAction(loginAction, values, {
              onError: (error) => {
                message.error(error)
              },
              onSuccess: (token) => {
                saveToken(token)
                message.success('登录成功')
                router.replace(Pages.dashboard)
              },
            })
          },
        }}
      >
        <Button
          className="mb-2"
          icon={<LoginOutlined />}
          type="primary"
          htmlType="submit"
          size="large"
          block
        >
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
          <Spin size="large" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  )
}
