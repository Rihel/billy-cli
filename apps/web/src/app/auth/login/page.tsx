'use client'

import { authStorage } from '@/lib/auth'
import { loginAction } from '@/actions/auth.actions'
import { LoginOutlined } from '@ant-design/icons'
import { FormRenderer, IconText } from '@repo/ui'
import { App, Form, Typography } from 'antd'
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
            const result = await loginAction(values)
            if (!result.ok) {
              message.error(result.error)
              return
            }
            authStorage.setToken(result.data)
            message.success('登录成功')
            router.replace(Pages.dashboard)
          },
        }}
      >
        <IconText
          className="mb-2"
          icon={LoginOutlined}
          type="primary"
          htmlType="submit"
          size="large"
          block
        >
          登录
        </IconText>
        <div className="flex justify-between text-sm">
          <Link href={Pages.register}>没有账号？去注册</Link>
          <Link href={Pages.forgotPassword}>忘记密码？</Link>
        </div>
      </FormRenderer>
    </>
  )
}
