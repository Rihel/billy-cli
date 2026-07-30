'use client'

import { saveToken } from '@/lib/server-client'
import { loginAction } from '@/actions/auth.actions'
import { LoginOutlined } from '@ant-design/icons'
import { FormRenderer } from '@repo/aui'
import { callAction } from '@repo/aui/action'
import { App, Button, Form, Typography } from 'antd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AppName, Pages } from '@/lib/constants'

type LoginForm = {
  email: string
  password: string
}

export default function LoginPage() {
  const { message } = App.useApp()
  const router = useRouter()
  const [form] = Form.useForm<LoginForm>()

  return (
    <>
      <div className="text-center mb-6">
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          {AppName}
        </Typography.Title>
        <Typography.Text type="secondary">欢迎登录</Typography.Text>
      </div>
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
        <div className="flex justify-between text-sm">
          <Link href={Pages.register}>没有账号？去注册</Link>
          <Link href={Pages.forgotPassword}>忘记密码？</Link>
        </div>
      </FormRenderer>
    </>
  )
}
