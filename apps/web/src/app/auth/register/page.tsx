'use client'

import { authStorage } from '@/lib/auth'
import { registerAction } from '@/actions/auth.actions'
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

export default function RegisterPage() {
  const { message } = App.useApp()
  const router = useRouter()

  return (
    <Form
      layout="vertical"
      onFinish={async (values: {
        email: string
        password: string
        realName?: string
      }) => {
        const result = await registerAction(values)
        if (!result.ok) {
          message.error(result.error)
          return
        }
        authStorage.setToken(result.data)
        message.success('注册成功')
        router.replace(Pages.dashboard)
      }}
    >
      <div className="text-center mb-6">
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Billy CLI
        </Typography.Title>
        <Typography.Text type="secondary">创建新账号</Typography.Text>
      </div>
      <Form.Item
        name="email"
        rules={[
          { required: true },
          { type: 'email', message: '请输入有效邮箱' },
        ]}
      >
        <Input size="large" placeholder="请输入邮箱" />
      </Form.Item>
      <Form.Item name="realName">
        <Input size="large" placeholder="请输入真实姓名（可选）" />
      </Form.Item>
      <Form.Item
        name="password"
        rules={[{ required: true }, { min: 6, message: '密码至少 6 位' }]}
      >
        <Input.Password size="large" placeholder="请输入密码（至少 6 位）" />
      </Form.Item>
      <Form.Item
        name="confirmPassword"
        dependencies={['password']}
        rules={[
          { required: true },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('password') === value) {
                return Promise.resolve()
              }
              return Promise.reject(new Error('两次密码不一致'))
            },
          }),
        ]}
      >
        <Input.Password size="large" placeholder="请再次输入密码" />
      </Form.Item>
      <Form.Item style={{ marginBottom: 8 }}>
        <Button type="primary" htmlType="submit" size="large" block>
          注册
        </Button>
      </Form.Item>
      <div className="text-sm text-center">
        已有账号？<Link href={Pages.login}>去登录</Link>
      </div>
    </Form>
  )
}
