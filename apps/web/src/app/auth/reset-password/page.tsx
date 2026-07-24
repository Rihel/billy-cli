'use client'

import { resetPasswordAction } from '@/actions/auth.actions'
import { App, Button, Card, Form, Input, Typography } from 'antd'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'

const { Title } = Typography

function ResetPasswordForm() {
  const { message } = App.useApp()
  const router = useRouter()
  const searchParams = useSearchParams()
  const tokenFromUrl = searchParams.get('token') ?? ''
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values: {
    token: string
    password: string
    confirmPassword: string
  }) => {
    setLoading(true)
    const { confirmPassword: _, ...rest } = values
    const result = await resetPasswordAction(rest)
    setLoading(false)
    if (!result.ok) {
      message.error(result.error)
    } else {
      message.success('密码重置成功，请重新登录')
      router.replace('/auth/login')
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-sm shadow-md">
        <Title level={3} className="text-center mb-6">
          重置密码
        </Title>
        <Form
          form={form}
          layout="vertical"
          initialValues={{ token: tokenFromUrl }}
          onFinish={handleSubmit}
        >
          <Form.Item
            name="token"
            label="重置令牌"
            rules={[{ required: true, message: '请输入重置令牌' }]}
          >
            <Input placeholder="粘贴邮件中的重置令牌" />
          </Form.Item>
          <Form.Item
            name="password"
            label="新密码"
            rules={[{ required: true }, { min: 6, message: '密码至少 6 位' }]}
          >
            <Input.Password placeholder="请输入新密码" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
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
            <Input.Password placeholder="请再次输入新密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" block loading={loading}>
              重置密码
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  )
}
