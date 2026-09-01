import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'

import './globals.css'

import { cn } from '@repo/ui'
import { Providers } from '@/providers/AppProviders'
import { AppName } from '@/lib/constants'
import { Suspense } from 'react'

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: AppName,
  description: '超强脚手架',
}

/**
 * 主题引导脚本：在 React 水合前根据 localStorage / 系统偏好设置 .dark，
 * 避免深色模式刷新时白屏闪烁（FOUC）。
 */
const themeBootScript = `(function(){try{var t=localStorage.getItem('billy-admin-theme');var d=t==='dark'||((!t||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className={cn(geist.variable, geistMono.variable)}>
      <body className={cn('bg-background font-sans antialiased', geist.variable)}>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <Providers>
          <Suspense>{children}</Suspense>
        </Providers>
      </body>
    </html>
  )
}
