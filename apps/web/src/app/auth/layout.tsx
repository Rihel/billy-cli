import type { Metadata } from 'next'
import { AppName, Pages } from '@/lib/constants'
import Link from 'next/link'

export const metadata: Metadata = {
  title: `登录注册 - ${AppName}`,
}

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen">
      {/* Left: branding panel */}
      <div className="relative hidden w-[480px] flex-col justify-between bg-zinc-900 p-12 lg:flex">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-zinc-800 via-zinc-900 to-zinc-950" />
        <div className="relative z-10">
          <Link
            href={Pages.home}
            className="inline-flex items-center gap-2 text-sm text-zinc-400 transition-colors hover:text-white"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 8H4" />
              <path d="M7 4L3 8L7 12" />
            </svg>
            {AppName} 首页
          </Link>
        </div>
        <div className="relative z-10 space-y-3">
          <p className="text-3xl font-semibold leading-tight tracking-tight text-white">
            全栈开发<br />从这里开始
          </p>
          <p className="text-sm leading-relaxed text-zinc-400">
            NestJS 后端 · Next.js 前端 · PostgreSQL + Redis
          </p>
        </div>
        <div className="relative z-10">
          <p className="text-xs text-zinc-500">
            &copy; {new Date().getFullYear()} {AppName}. All rights reserved.
          </p>
        </div>
      </div>

      {/* Right: form area */}
      <div className="flex flex-1 items-center justify-center bg-white px-6 dark:bg-zinc-950">
        <div className="w-full max-w-[360px]">
          {/* Mobile back link */}
          <Link
            href={Pages.home}
            className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground lg:hidden"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 8H4" />
              <path d="M7 4L3 8L7 12" />
            </svg>
            返回首页
          </Link>
          {children}
        </div>
      </div>
    </div>
  )
}
