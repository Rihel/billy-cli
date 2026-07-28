'use client'

import { resetPasswordAction } from '@/actions/auth.actions'
import { KeyOutlined } from '@ant-design/icons'
import { FormRenderer } from '@repo/ui'
import { callAction } from '@repo/ui/action'
import { App, Button, Form, Typography } from 'antd'
import { useBoolean } from 'ahooks'
import { useRouter, useSearchParams } from 'next/navigation'

const { Title } = Typography

type ResetPasswordForm = {
  token: string
  password: string
  confirmPassword: string
}

export default function ResetPasswordPage() {
  const { message } = App.useApp()
  const router = useRouter()
  const searchParams = useSearchParams()
  const tokenFromUrl = searchParams.get('token') ?? ''
  const [form] = Form.useForm<ResetPasswordForm>()
  const [loading, { setTrue: startLoading, setFalse: stopLoading }] =
    useBoolean()

  const handleSubmit = async (values: ResetPasswordForm) => {
    startLoading()
    const { confirmPassword: _, ...rest } = values
    await callAction(resetPasswordAction, rest, {
      onError: (error) => {
        message.error(error)
      },
      onSuccess: () => {
        message.success('密码重置成功，请重新登录')
        router.replace('/auth/login')
      },
    })
    stopLoading()
  }

  return (
    <>
      <Title level={3} className="text-center mb-6">
        重置密码
      </Title>
      <FormRenderer<ResetPasswordForm>
        form={form}
        items={[
          {
            name: 'token',
            label: '重置令牌',
            formItemProps: {
              rules: [{ required: true, message: '请输入重置令牌' }],
            },
            props: { placeholder: '粘贴邮件中的重置令牌' },
          },
          {
            name: 'password',
            label: '新密码',
            widget: 'password',
            formItemProps: {
              rules: [{ required: true }, { min: 6, message: '密码至少 6 位' }],
            },
            props: {
              placeholder: '请输入新密码',
              autoComplete: 'new-password',
            },
          },
          {
            name: 'confirmPassword',
            label: '确认新密码',
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
              placeholder: '请再次输入新密码',
              autoComplete: 'new-password',
            },
          },
        ]}
        formProps={{
          initialValues: { token: tokenFromUrl },
          onFinish: handleSubmit,
        }}
      >
        <Button
          icon={<KeyOutlined />}
          type="primary"
          htmlType="submit"
          block
          loading={loading}
        >
          重置密码
        </Button>
      </FormRenderer>
    </>
  )
}
