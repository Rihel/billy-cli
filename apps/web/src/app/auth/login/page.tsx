'use client'

import { authStorage } from '@/lib/auth'
import { loginAction } from '@/actions/auth.actions'
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AppName, Pages } from '@/lib/constants'

export default function LoginPage() {
  const { message } = App.useApp()
  const router = useRouter()

  return (
    <Form
      layout="vertical"
      onFinish={async (values: { email: string; password: string }) => {
        const result = await loginAction(values)
        if (!result.ok) {
          message.error(result.error)
          return
        }
        authStorage.setToken(result.data)
        message.success('登录成功')
        router.replace(Pages.dashboard)
      }}
    >
      <div className="text-center mb-6">
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {AppName}
        </Typography.Title>
        <Typography.Text type="secondary">欢迎登录</Typography.Text>
      </div>
      <Form.Item
        name="email"
        rules={[
          { required: true },
          { type: 'email', message: '请输入有效邮箱' },
        ]}
      >
        <Input size="large" placeholder="请输入邮箱" autoComplete="email" />
      </Form.Item>
      <Form.Item name="password" rules={[{ required: true }]}>
        <Input.Password size="large" placeholder="请输入密码" />
      </Form.Item>
      <Form.Item style={{ marginBottom: 8 }}>
        <Button type="primary" htmlType="submit" size="large" block>
          登录
        </Button>
      </Form.Item>
      <div className="flex justify-between text-sm">
        <Link href={Pages.register}>没有账号？去注册</Link>
        <Link href={Pages.forgotPassword}>忘记密码？</Link>
      </div>
    </Form>
  )
}
