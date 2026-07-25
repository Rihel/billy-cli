'use client'

import { HomeOutlined } from '@ant-design/icons'
import { IconText } from '@repo/ui'
import { Result } from 'antd'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Result
        status="404"
        title="404"
        subTitle="抱歉，您访问的页面不存在。"
        extra={
          <Link href={Pages.dashboard}>
            <IconText icon={HomeOutlined} type="primary">
              回到首页
            </IconText>
          </Link>
        }
      />
    </div>
  )
}
