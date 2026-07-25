'use client'

import { HomeOutlined } from '@ant-design/icons'
import { IconText } from '@repo/ui'
import { Result } from 'antd'
import Link from 'next/link'
import { Pages } from '@/lib/constants'

export default function Forbidden() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <Result
        status="403"
        title="403"
        subTitle="抱歉，您没有权限访问该页面。"
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
