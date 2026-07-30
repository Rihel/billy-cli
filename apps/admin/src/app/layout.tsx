import type { Metadata } from 'next'
import { AntdRegistry } from '@ant-design/nextjs-registry'

import './globals.css'

import { Providers } from '@/providers/AppProviders'
import { AppName } from '@/lib/constants'
import { Suspense } from 'react'

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
      <body>
        <AntdRegistry>
          <Providers>
            <Suspense>{children}</Suspense>
          </Providers>
        </AntdRegistry>
      </body>
    </html>
  )
}
