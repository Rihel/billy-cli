'use client'

import { forgotPasswordAction } from '@/actions/auth.actions'
import { SendOutlined } from '@ant-design/icons'
import { FormRenderer } from '@repo/ui'
import { callAction } from '@repo/ui/action'
import { useBoolean } from 'ahooks'
import { Alert, App, Button, Form, Typography } from 'antd'
import Link from 'next/link'

const { Title, Text } = Typography

export default function ForgotPasswordPage() {
  const { message } = App.useApp()
  const [form] = Form.useForm<{ email: string }>()
  const [submitted, { setTrue: markSubmitted }] = useBoolean()
  const [loading, { setTrue: startLoading, setFalse: stopLoading }] =
    useBoolean()

  const handleSubmit = async (values: { email: string }) => {
    startLoading()
    await callAction(forgotPasswordAction, values, {
      onError: (error) => {
        message.error(error)
      },
      onSuccess: markSubmitted,
    })
    stopLoading()
  }

  return (
    <div>
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
          <FormRenderer<{ email: string }>
            form={form}
            items={[
              {
                name: 'email',
                label: '邮箱',
                formItemProps: {
                  rules: [
                    { required: true },
                    { type: 'email', message: '请输入有效邮箱' },
                  ],
                },
                props: { placeholder: '请输入注册邮箱' },
              },
            ]}
            formProps={{ onFinish: handleSubmit }}
          >
            <Button
              icon={<SendOutlined />}
              type="primary"
              htmlType="submit"
              block
              loading={loading}
            >
              发送重置令牌
            </Button>
          </FormRenderer>
          <div className="text-sm text-center mt-4">
            <Link href="/auth/login">返回登录</Link>
          </div>
        </>
      )}
    </div>
  )
}
