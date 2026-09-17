import Link from 'next/link'
import { HomeIcon } from 'lucide-react'
import { Button } from '@repo/ui'
import { Pages } from '@/lib/constants'

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="font-mono text-6xl font-semibold tracking-tight text-zinc-900">
          404
        </div>
        <p className="text-sm text-zinc-500">抱歉，你访问的页面不存在。</p>
        <Button render={<Link href={Pages.home} />}>
          <HomeIcon />
          回到首页
        </Button>
      </div>
    </div>
  )
}
