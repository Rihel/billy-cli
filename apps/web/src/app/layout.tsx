import type { Metadata } from "next"
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google"
import { Toaster, TooltipProvider } from "@repo/ui"
import { QueryProvider } from "@/providers/QueryProvider"
import { WebStorageProvider } from "@/providers/WebStorageProvider"
import "./globals.css"

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
})

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
})

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
})

export const metadata: Metadata = {
  title: "Billy CLI - 全栈应用 Monorepo 模板",
  description:
    "基于 NestJS 12 与 Next.js 16 的全栈应用模板：数据结构先行、双前端开箱即用，从脚手架到生产部署一步到位。",
}

/** 前端根 layout 统一动态渲染（每次请求 SSR，不做整站静态预渲染）。 */
export const dynamic = "force-dynamic"

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="zh-CN"
      className={`${geist.variable} ${geistMono.variable} ${spaceGrotesk.variable}`}
    >
      <body className="min-h-screen bg-background font-sans antialiased">
        <QueryProvider>
          <WebStorageProvider>
            <TooltipProvider>{children}</TooltipProvider>
          </WebStorageProvider>
        </QueryProvider>
        {/* 全局 toast 容器：TanStack Query 的统一错误提示 / 页面操作反馈都经它渲染 */}
        <Toaster />
      </body>
    </html>
  )
}
