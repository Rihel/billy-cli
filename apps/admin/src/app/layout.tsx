import type { Metadata } from 'next'
import { Geist } from 'next/font/google'

import './globals.css'

import { cn } from '@repo/ui'
import { Providers } from '@/providers/AppProviders'
import { AppName } from '@/lib/constants'
import { Suspense } from 'react'

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
})

export const metadata: Metadata = {
  title: AppName,
  description: '超强脚手架',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN">
      <body className={cn('bg-background font-sans antialiased', geist.variable)}>
        <Providers>
          <Suspense>{children}</Suspense>
        </Providers>
      </body>
    </html>
  )
}
