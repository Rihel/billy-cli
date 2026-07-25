'use client'
import { useStorage } from '@/hooks/use-storage'
import { useAuthStore } from '@/stores/auth.store'
import { PlusOutlined } from '@ant-design/icons'
import { formatTime } from '@repo/shared'
import { cn } from '@repo/ui'
import { Form, Tabs, Upload } from 'antd'
import FormItem from 'antd/es/form/FormItem'

export default function UserCenter() {
  const { userInfo } = useAuthStore()
  const { customRequest } = useStorage()
  return (
    <Form colon={false}>
      <Upload
        customRequest={customRequest}
        showUploadList={false}
        accept="image/*"
      >
        <div
          className={cn(
            'w-20 h-20 bg-slate-100 border border-dashed border-slate-200 flex justify-center items-center',
            'cursor-pointer hover:bg-slate-50',
          )}
        >
          <PlusOutlined className="text-3xl text-gray-100" />
        </div>
      </Upload>

      <FormItem label="邮箱">{userInfo?.email}</FormItem>
      <FormItem label="注册时间">{formatTime(userInfo?.createdAt)}</FormItem>
    </Form>
  )
}
