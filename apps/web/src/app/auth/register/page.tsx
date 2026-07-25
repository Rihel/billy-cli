'use client'

import { authStorage } from '@/lib/auth'
import { registerAction } from '@/actions/auth.actions'
import { UserAddOutlined } from '@ant-design/icons'
import { FormRenderer, IconText } from '@repo/ui'
import { App, Form, Typography } from 'antd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

type RegisterForm = {
  email: string
  password: string
  confirmPassword: string
  realName?: string
}

export default function RegisterPage() {
  const { message } = App.useApp()
  const router = useRouter()
  const [form] = Form.useForm<RegisterForm>()

  return (
    <>
      <div className="text-center mb-6">
        <Typography.Title level={3} style={{ marginBottom: 4 }}>
          Billy CLI
        </Typography.Title>
        <Typography.Text type="secondary">创建新账号</Typography.Text>
      </div>
      <FormRenderer<RegisterForm>
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
            props: { size: 'large', placeholder: '请输入邮箱' },
          },
          {
            name: 'realName',
            props: { size: 'large', placeholder: '请输入真实姓名（可选）' },
          },
          {
            name: 'password',
            widget: 'password',
            formItemProps: {
              rules: [{ required: true }, { min: 6, message: '密码至少 6 位' }],
            },
            props: {
              size: 'large',
              placeholder: '请输入密码（至少 6 位）',
              autoComplete: 'new-password',
            },
          },
          {
            name: 'confirmPassword',
            widget: 'password',
            formItemProps: {
              dependencies: ['password'],
              rules: [
                { required: true },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('password') === value)
                      return Promise.resolve()
                    return Promise.reject(new Error('两次密码不一致'))
                  },
                }),
              ],
            },
            props: {
              size: 'large',
              placeholder: '请再次输入密码',
              autoComplete: 'new-password',
            },
          },
        ]}
        formProps={{
          onFinish: async ({ confirmPassword: _, ...values }) => {
            const result = await registerAction(values)
            if (!result.ok) {
              message.error(result.error)
              return
            }
            authStorage.setToken(result.data)
            message.success('注册成功')
            router.replace(Pages.dashboard)
          },
        }}
      >
        <IconText
          className="mb-2"
          icon={UserAddOutlined}
          type="primary"
          htmlType="submit"
          size="large"
          block
        >
          注册
        </IconText>
        <div className="text-sm text-center">
          已有账号？<Link href={Pages.login}>去登录</Link>
        </div>
      </FormRenderer>
    </>
  )
}
