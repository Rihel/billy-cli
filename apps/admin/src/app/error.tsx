'use client'

import { ReloadOutlined } from '@ant-design/icons'
import { IconText } from '@repo/aui'
import { Result } from 'antd'

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Result
        status="500"
        title="出错了"
        subTitle="服务器发生了一些问题，请稍后重试。"
        extra={
          <IconText icon={ReloadOutlined} type="primary" onClick={reset}>
            重试
          </IconText>
        }
      />
    </div>
  )
}
