'use client'
import { logoutAction } from '@/actions/auth.actions'
import { authStorage } from '@/lib/auth'
import { useTRPC } from '@/lib/client-trpc'
import { useAuthStore } from '@/stores/auth.store'
import { useMutation } from '@tanstack/react-query'
import { Button, Form, Input } from 'antd'
import useApp from 'antd/es/app/useApp'
import FormItem from 'antd/es/form/FormItem'
import { useRouter } from 'next/navigation'
import {
  DisplayRender,
  EditableInput,
  Group,
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
  const { message } = useApp()
  const router = useRouter()
  const tpc = useTRPC()

  const updateInfoMutation = useMutation(
    tpc.auth.updateInfo.mutationOptions({}),
  )
  const changePasswordMutation = useMutation(
    tpc.auth.changePassword.mutationOptions({}),
  )

  const changePassword = async (values: ChangePasswordForm) => {
    const { confirmPassword: _, ...input } = values
    await changePasswordMutation.mutateAsync(input)
    message.success('密码修改成功，请重新登录')
    clear()
    authStorage.removeToken()
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
              <Button type="link" onClick={() => passwordDialog.open()}>
                修改密码
              </Button>
            ),
          },
        ]}
      />

      <ModalForm<ChangePasswordForm>
        title="修改密码"
        open={passwordDialog.isOpen}
        form={passwordForm}
        loading={changePasswordMutation.isPending}
        onSubmit={changePassword}
        onCancel={passwordDialog.close}
        formProps={{ requiredMark: false }}
        modalProps={{ okText: '确认修改', cancelText: '取消' }}
      >
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
      </ModalForm>
    </Group>
  )
}
