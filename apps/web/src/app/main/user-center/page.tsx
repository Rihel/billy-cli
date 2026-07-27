'use client'
import { logoutAction } from '@/actions/auth.actions'
import { removeToken } from '@/lib/server-client'
import { useServerClient } from '@/lib/server-client'
import { useAuthStore } from '@/stores/auth.store'
import { LockOutlined } from '@ant-design/icons'
import { useMutation } from '@tanstack/react-query'
import { App, Form } from 'antd'
import { useRouter } from 'next/navigation'
import {
  DisplayRender,
  EditableInput,
  Group,
  IconText,
  ImageUpload,
  ModalForm,
  useDisclosure,
} from '@repo/ui'

type ChangePasswordForm = {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

export default function UserCenter() {
  const { userInfo, setUserInfo, clear } = useAuthStore()
  const passwordDialog = useDisclosure()
  const [passwordForm] = Form.useForm<ChangePasswordForm>()
  const { message } = App.useApp()
  const router = useRouter()
  const client = useServerClient()

  const updateInfoMutation = useMutation({
    mutationFn: (input: { realName?: string | null; avatar?: string | null }) =>
      client.auth.updateInfo(input),
  })
  const changePasswordMutation = useMutation({
    mutationFn: (input: { oldPassword: string; newPassword: string }) =>
      client.auth.changePassword(input),
  })

  const changePassword = async (values: ChangePasswordForm) => {
    const { confirmPassword: _, ...input } = values
    await changePasswordMutation.mutateAsync(input)
    message.success('密码修改成功，请重新登录')
    clear()
    removeToken()
    await logoutAction()
    router.replace('/auth/login')
  }

  return (
    <Group title="个人资料" className="max-w-2xl">
      <ImageUpload
        value={userInfo?.avatar}
        sizeLimit={2}
        disabled={updateInfoMutation.isPending}
        onChange={async (avatar) => {
          await updateInfoMutation.mutateAsync({ avatar })
          setUserInfo({ ...userInfo!, avatar })
        }}
      />

      <DisplayRender
        data={userInfo}
        layout="row"
        className="mt-6"
        items={[
          { name: 'email', label: '邮箱' },
          {
            name: 'realName',
            label: '真实姓名',
            render: (realName) => (
              <EditableInput
                value={realName as string | null}
                onChange={async (nextRealName) => {
                  await updateInfoMutation.mutateAsync({
                    realName: nextRealName,
                  })
                  setUserInfo({ ...userInfo!, realName: nextRealName })
                }}
              />
            ),
          },
          {
            name: 'createdAt',
            label: '注册时间',
            displayProps: { type: 'date' },
          },
          {
            label: '密码',
            render: () => (
              <IconText
                icon={LockOutlined}
                onClick={() => passwordDialog.open()}
              >
                修改密码
              </IconText>
            ),
          },
        ]}
      />

      <ModalForm<ChangePasswordForm>
        title="修改密码"
        open={passwordDialog.isOpen}
        form={passwordForm}
        items={[
          {
            name: 'oldPassword',
            label: '旧密码',
            widget: 'password',
            formItemProps: {
              rules: [{ required: true, message: '请输入旧密码' }],
            },
            props: { autoComplete: 'current-password' },
          },
          {
            name: 'newPassword',
            label: '新密码',
            widget: 'password',
            formItemProps: {
              rules: [
                { required: true, message: '请输入新密码' },
                { min: 6, message: '密码至少 6 位' },
              ],
            },
            props: { autoComplete: 'new-password' },
          },
          {
            name: 'confirmPassword',
            label: '确认新密码',
            widget: 'password',
            formItemProps: {
              dependencies: ['newPassword'],
              rules: [
                { required: true, message: '请再次输入新密码' },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue('newPassword') === value)
                      return Promise.resolve()
                    return Promise.reject(new Error('两次密码输入不一致'))
                  },
                }),
              ],
            },
            props: { autoComplete: 'new-password' },
          },
        ]}
        loading={changePasswordMutation.isPending}
        onSubmit={changePassword}
        onCancel={passwordDialog.close}
        formProps={{ requiredMark: false }}
        modalProps={{ okText: '确认修改', cancelText: '取消' }}
      />
    </Group>
  )
}
