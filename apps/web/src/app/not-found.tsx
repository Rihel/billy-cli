import { Button, Result } from 'antd'
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
            <Button type="primary">回到首页</Button>
          </Link>
        }
      />
    </div>
  )
}
