import { Button, Result } from 'antd'
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
            <Button type="primary">回到首页</Button>
          </Link>
        }
      />
    </div>
  )
}
