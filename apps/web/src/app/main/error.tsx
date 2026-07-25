'use client'

import { HomeOutlined, ReloadOutlined } from '@ant-design/icons'
import { IconText } from '@repo/ui'
import { Result } from 'antd'
import { useRouter } from 'next/navigation'
import { Pages } from '@/lib/constants'

export default function MainError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Result
        status="500"
        title="页面加载失败"
        subTitle="加载数据时遇到问题，请重试或返回首页。"
        extra={[
          <IconText
            key="retry"
            icon={ReloadOutlined}
            type="primary"
            onClick={reset}
          >
            重试
          </IconText>,
          <IconText
            key="home"
            icon={HomeOutlined}
            onClick={() => router.replace(Pages.dashboard)}
          >
            回到首页
          </IconText>,
        ]}
      />
    </div>
  )
}
