'use client'
import { logoutAction } from '@/actions/auth.actions'
import { removeToken } from '@/lib/server-client'
import { useServerClient } from '@/lib/server-client'
import { useAuthStore } from '@/stores/auth.store'
import { useForm } from '@tanstack/react-form'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import {
  DisplayRender,
  EditableInput,
  Group,
  IconText,
  ImageUpload,
  ModalForm,
  PageToolbar,
  toastSuccess,
  useDisclosure,
} from '@repo/ui'
import { KeyRoundIcon } from 'lucide-react'

type ChangePasswordForm = {
  oldPassword: string
  newPassword: string
  confirmPassword: string
}

export default function UserCenter() {
  const { adminInfo, setAdminInfo, clear } = useAuthStore()
  const passwordDialog = useDisclosure()
  const router = useRouter()
  const client = useServerClient()

  const updateInfoMutation = useMutation({
    mutationFn: (input: { realName?: string | null; avatar?: string | null }) =>
      client.admin.updateInfo(input),
  })
  const changePasswordMutation = useMutation({
    mutationFn: (input: { oldPassword: string; newPassword: string }) =>
      client.admin.changePassword(input),
  })

  const passwordForm = useForm({
    defaultValues: { oldPassword: '', newPassword: '', confirmPassword: '' },
    onSubmit: async ({ value }) => {
      const { confirmPassword: _, ...input } = value
      await changePasswordMutation.mutateAsync(input)
      toastSuccess('密码修改成功，请重新登录')
      clear()
      removeToken()
      await logoutAction()
      router.replace('/auth/login')
    },
  })

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-8">
      <PageToolbar title="个人中心" description="管理员个人资料与账号安全" />
      <div className="border-t border-b border-border py-6">
        <div className="flex flex-col gap-8 sm:flex-row sm:gap-10">
          <ImageUpload
            value={adminInfo?.avatar}
            sizeLimit={5}
            disabled={updateInfoMutation.isPending}
            onChange={async (avatar) => {
              await updateInfoMutation.mutateAsync({ avatar })
              setAdminInfo({ ...adminInfo!, avatar })
            }}
          />

          <DisplayRender
            data={adminInfo}
            layout="row"
            labelClassName="w-20"
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
                      setAdminInfo({ ...adminInfo!, realName: nextRealName })
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
                    icon={<KeyRoundIcon />}
                    type="primary"
                    onClick={() => passwordDialog.open()}
                  >
                    修改密码
                  </IconText>
                ),
              },
            ]}
          />
        </div>
      </div>

      <ModalForm<ChangePasswordForm>
        title="修改密码"
        open={passwordDialog.isOpen}
        form={passwordForm}
        submitText="确认修改"
        items={[
          {
            name: 'oldPassword',
            label: '旧密码',
            widget: 'password',
            hint: '输入当前使用的密码以验证身份',
            required: '请输入旧密码',
            props: { autoComplete: 'current-password' },
          },
          {
            name: 'newPassword',
            label: '新密码',
            widget: 'password',
            hint: '至少 6 位；建议字母、数字与符号混合',
            required: '请输入新密码',
            validate: (value) =>
              typeof value === 'string' && value.length > 0 && value.length < 6
                ? '密码至少 6 位'
                : undefined,
            props: { autoComplete: 'new-password' },
          },
          {
            name: 'confirmPassword',
            label: '确认新密码',
            widget: 'password',
            hint: '再次输入新密码，两次需一致',
            required: '请再次输入新密码',
            validate: (value, values) =>
              value !== values.newPassword ? '两次密码输入不一致' : undefined,
            props: { autoComplete: 'new-password' },
          },
        ]}
        onCancel={passwordDialog.close}
      />
    </div>
  )
}
