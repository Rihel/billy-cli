import type { Metadata } from 'next'
import { AppName, Pages } from '@/lib/constants'
import Link from 'next/link'
import { ArrowLeftIcon } from 'lucide-react'

export const metadata: Metadata = {
  title: `登录注册 - ${AppName}`,
}

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      {/* Left: branding panel（亮色系：浅蓝氛围 + 品牌蓝 accent） */}
      <div className="relative hidden w-[480px] flex-col justify-between overflow-hidden border-r border-brand/20 bg-gradient-to-b from-brand/10 via-brand/10 to-white p-12 lg:flex">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-brand/10 blur-3xl"
        />
        <div className="relative z-10">
          <Link
            href={Pages.home}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-brand"
          >
            <ArrowLeftIcon className="size-4" />
            {AppName} 首页
          </Link>
        </div>
        <div className="relative z-10 space-y-4">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-foreground">
            全栈开发
            <br />
            从这里开始
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            NestJS 后端 · Next.js 前端 · PostgreSQL + Redis
          </p>
        </div>
        <div className="relative z-10">
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} {AppName}. All rights reserved.
          </p>
        </div>
      </div>

      {/* Right: form area */}
      <div className="flex flex-1 items-center justify-center bg-card px-6">
        <div className="w-full max-w-[360px]">
          {/* Mobile back link */}
          <Link
            href={Pages.home}
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            <ArrowLeftIcon className="size-3.5" />
            返回首页
          </Link>
          {children}
        </div>
      </div>
    </div>
  )
}
