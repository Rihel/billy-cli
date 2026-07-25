'use client'
import { logoutAction } from '@/actions/auth.actions'
import EditableInput from '@/components/EditableInput'
import { ImageUpload } from '@/components/ImageUpload'
import { authStorage } from '@/lib/auth'
import { useTRPC } from '@/lib/client-trpc'
import { useAuthStore } from '@/stores/auth.store'
import { formatTime } from '@repo/shared'
import { useMutation } from '@tanstack/react-query'
import { Button, Form, Input, Modal } from 'antd'
import useApp from 'antd/es/app/useApp'
import FormItem from 'antd/es/form/FormItem'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

type ChangePasswordForm = {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

export default function UserCenter() {
  const { userInfo, setUserInfo, clear } = useAuthStore()
  const [passwordModalOpen, setPasswordModalOpen] = useState(false)
  const [passwordForm] = Form.useForm<ChangePasswordForm>()
  const { message } = useApp()
  const router = useRouter()
  const tpc = useTRPC()

  const updateInfoMutation = useMutation(
    tpc.auth.updateInfo.mutationOptions({}),
  )
  const changePasswordMutation = useMutation(
    tpc.auth.changePassword.mutationOptions({}),
  )

  const changePassword = async () => {
    const { confirmPassword: _, ...input } = await passwordForm.validateFields()
    await changePasswordMutation.mutateAsync(input)
    message.success('密码修改成功，请重新登录')
    clear()
    authStorage.removeToken()
    await logoutAction()
    router.replace('/auth/login')
  }

  return (
    <Form
      colon={false}
      labelCol={{ span: 4 }}
      labelAlign="left"
      component={false}
    >
      <ImageUpload
        value={userInfo?.avatar}
        sizeLimit={2}
        disabled={updateInfoMutation.isPending}
        onChange={async (avatar) => {
          await updateInfoMutation.mutateAsync({ avatar })
          setUserInfo({ ...userInfo!, avatar })
        }}
      />

      <FormItem label="邮箱">{userInfo?.email}</FormItem>
      <FormItem label="真实姓名">
        <EditableInput
          value={userInfo?.realName!}
          onChange={async (realName) => {
            await updateInfoMutation.mutateAsync({ realName })
            setUserInfo({ ...userInfo!, realName })
          }}
        >
          {userInfo?.realName}
        </EditableInput>
      </FormItem>
      <FormItem label="注册时间">{formatTime(userInfo?.createdAt)}</FormItem>
      <FormItem label="密码">
        <Button type="link" onClick={() => setPasswordModalOpen(true)}>
          修改密码
        </Button>
      </FormItem>

      <Modal
        title="修改密码"
        open={passwordModalOpen}
        okText="确认修改"
        cancelText="取消"
        confirmLoading={changePasswordMutation.isPending}
        onOk={changePassword}
        onCancel={() => setPasswordModalOpen(false)}
        afterClose={() => passwordForm.resetFields()}
        destroyOnHidden
      >
        <Form form={passwordForm} layout="vertical" requiredMark={false}>
          <FormItem
            name="oldPassword"
            label="旧密码"
            rules={[{ required: true, message: '请输入旧密码' }]}
          >
            <Input.Password autoComplete="current-password" />
          </FormItem>
          <FormItem
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </FormItem>
          <FormItem
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve()
                  }
                  return Promise.reject(new Error('两次密码输入不一致'))
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </FormItem>
        </Form>
      </Modal>
    </Form>
  )
}
