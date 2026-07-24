'use client'

import { authStorage } from '@/lib/auth'
import { registerAction } from '@/actions/auth.actions'
import {
  LoginForm,
  ProFormDependency,
  ProFormText,
} from '@ant-design/pro-components'
import { App } from 'antd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

export default function RegisterPage() {
  const { message } = App.useApp()
  const router = useRouter()

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <LoginForm
        title="Billy CLI"
        subTitle="创建新账号"
        submitter={{ searchConfig: { submitText: '注册' } }}
        onFinish={async (values: {
          email: string
          password: string
          realName?: string
        }) => {
          const result = await registerAction(values)
          if (!result.ok) {
            message.error(result.error)
            return false
          }
          authStorage.setToken(result.data)
          message.success('注册成功')
          router.replace(Pages.dashboard)
        }}
        actions={
          <div className="text-sm text-center pt-2">
            已有账号？<Link href={Pages.login}>去登录</Link>
          </div>
        }
      >
        <ProFormText
          name="email"
          placeholder="请输入邮箱"
          fieldProps={{ size: 'large' }}
          rules={[
            { required: true },
            { type: 'email', message: '请输入有效邮箱' },
          ]}
        />
        <ProFormText
          name="realName"
          placeholder="请输入真实姓名（可选）"
          fieldProps={{ size: 'large' }}
        />
        <ProFormText.Password
          name="password"
          placeholder="请输入密码（至少 6 位）"
          fieldProps={{ size: 'large' }}
          rules={[{ required: true }, { min: 6, message: '密码至少 6 位' }]}
        />
        <ProFormDependency name={['password']}>
          {({ password }) => (
            <ProFormText.Password
              name="confirmPassword"
              placeholder="请再次输入密码"
              fieldProps={{ size: 'large' }}
              rules={[
                { required: true },
                {
                  validator: (_, value) =>
                    !value || password === value
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次密码不一致')),
                },
              ]}
            />
          )}
        </ProFormDependency>
      </LoginForm>
    </div>
  )
}
