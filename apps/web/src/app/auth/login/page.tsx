'use client'

import { authStorage } from '@/lib/auth'
import { loginAction } from '@/actions/auth.actions'
import { LoginForm, ProFormText } from '@ant-design/pro-components'
import { message } from 'antd'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

export default function LoginPage() {
  const router = useRouter()

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <LoginForm
        title="Billy CLI"
        subTitle="欢迎登录"
        onFinish={async (values: { email: string; password: string }) => {
          try {
            const token = await loginAction(values)
            authStorage.setToken(token)
            message.success('登录成功')
            router.replace(Pages.dashboard)
          } catch (err: any) {
            message.error(err?.message ?? '登录失败')
            return false
          }
        }}
        actions={
          <div className="flex justify-between w-full text-sm pt-2">
            <Link href={Pages.register}>没有账号？去注册</Link>
            <Link href={Pages.forgotPassword}>忘记密码？</Link>
          </div>
        }
      >
        <ProFormText
          name="email"
          placeholder="请输入邮箱"
          fieldProps={{ size: 'large', autoComplete: 'email' }}
          rules={[
            { required: true },
            { type: 'email', message: '请输入有效邮箱' },
          ]}
        />
        <ProFormText.Password
          name="password"
          placeholder="请输入密码"
          fieldProps={{ size: 'large' }}
          rules={[{ required: true }]}
        />
      </LoginForm>
    </div>
  )
}
