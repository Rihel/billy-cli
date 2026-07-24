'use client'

import { forgotPasswordAction } from '@/actions/auth.actions'
import { Button, Card, Form, Input, Typography, message, Alert } from 'antd'
import { useState } from 'react'
import Link from 'next/link'

const { Title, Text } = Typography

export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (values: { email: string }) => {
    setLoading(true)
    const result = await forgotPasswordAction(values)
    setLoading(false)
    if (!result.ok) {
      message.error(result.error)
    } else {
      setSubmitted(true)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Card className="w-full max-w-sm shadow-md">
        <Title level={3} className="text-center mb-6">
          找回密码
        </Title>
        {submitted ? (
          <div className="text-center space-y-4">
            <Alert
              type="success"
              message="重置链接已发送"
              description="如果该邮箱已注册，您将收到一封包含重置令牌的邮件，请查收。"
              showIcon
            />
            <Link href="/auth/login">返回登录</Link>
          </div>
        ) : (
          <>
            <Text type="secondary" className="block mb-4">
              输入您的注册邮箱，我们将发送重置密码的令牌。
            </Text>
            <Form layout="vertical" onFinish={handleSubmit}>
              <Form.Item
                name="email"
                label="邮箱"
                rules={[
                  { required: true },
                  { type: 'email', message: '请输入有效邮箱' },
                ]}
              >
                <Input placeholder="请输入注册邮箱" />
              </Form.Item>
              <Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={loading}
                >
                  发送重置令牌
                </Button>
              </Form.Item>
            </Form>
            <div className="text-sm text-center">
              <Link href="/auth/login">返回登录</Link>
            </div>
          </>
        )}
      </Card>
    </div>
  )
}
