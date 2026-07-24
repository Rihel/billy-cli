'use client'

import { Button, Result } from 'antd'
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
          <Button key="retry" type="primary" onClick={reset}>
            重试
          </Button>,
          <Button key="home" onClick={() => router.replace(Pages.dashboard)}>
            回到首页
          </Button>,
        ]}
      />
    </div>
  )
}
