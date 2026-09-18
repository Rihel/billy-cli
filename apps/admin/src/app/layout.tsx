import type { Metadata } from 'next'
import { Geist, Geist_Mono, Space_Grotesk } from 'next/font/google'

import './globals.css'

import { cn, createThemeBootScript } from '@repo/ui'
import { Providers } from '@/providers/AppProviders'
import { AppName, ThemeKey } from '@/lib/constants'
import { Suspense } from 'react'

/* 字体接线：下面三个变量名必须**写成字面量** —— next/font 的加载器要求编译期可静态分析的值，
 * 传变量会构建失败（Font loader values must be explicitly written literals）。
 * 变量名的契约在 @repo/ui/fonts，由 `pnpm check:ui` 校验这里与契约一致；
 * 族回退链定义在 ui 包的 globals.css 里，由 packages/ui/test/tokens.test.ts 守卫。 */
const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
})

export const metadata: Metadata = {
  title: AppName,
  description: '超强脚手架',
}

/** 前端根 layout 统一动态渲染（每次请求 SSR，不做整站静态预渲染）。 */
export const dynamic = 'force-dynamic'

/**
 * 主题引导脚本（生成器在 `@repo/ui`）：在 React 水合前根据 localStorage / 系统偏好设置 .dark，
 * 避免深色模式刷新时白屏闪烁（FOUC）。key 用 admin 自己的，与前台互不干扰。
 */
const themeBootScript = createThemeBootScript({ storageKey: ThemeKey })

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="zh-CN"
      className={cn(geist.variable, geistMono.variable, spaceGrotesk.variable)}
    >
      <body className={cn('bg-background font-sans antialiased', geist.variable)}>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <Providers>
          <Suspense>{children}</Suspense>
        </Providers>
      </body>
    </html>
  )
}
