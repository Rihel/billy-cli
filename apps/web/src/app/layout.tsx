import type { Metadata } from 'next'
import { AntdRegistry } from '@ant-design/nextjs-registry'

import './globals.css'

import { Providers } from '@/providers/AppProviders'
import { AppName } from '@/lib/constants'

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
          <Providers>{children}</Providers>
        </AntdRegistry>
      </body>
    </html>
  )
}
