import type { Metadata } from 'next'
import { Geist, Geist_Mono, Space_Grotesk } from 'next/font/google'

import '../globals.css'

import { cn, createThemeBootScript } from '@repo/ui'
import { ThemeKey } from '@/lib/constants'

/**
 * 分享页的独立 root layout（`/s/{token}`，设计 `docs/design/file-share.md` §6.1）。
 *
 * **不挂 `Providers`**（`AppProviders` 里有 `StorageClientProvider` → `useServerClient()`，
 * 会把后台 API 地址带进分享页的客户端 bundle）。这里只要 html/body + 字体 + 主题脚本。
 */

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })
const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
})

/** 中性标题：链接被转发到聊天工具时，抓到的卡片不能是后台的名字与描述 */
export const metadata: Metadata = {
  title: '文件预览',
  description: '在线查看分享的文件',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}

export const dynamic = 'force-dynamic'

const themeBootScript = createThemeBootScript({ storageKey: ThemeKey })

export default function ShareLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className={cn(geist.variable, geistMono.variable, spaceGrotesk.variable)}>
      <body className="bg-background font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {children}
      </body>
    </html>
  )
}
