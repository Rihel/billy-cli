import type { Metadata } from 'next'
import { createThemeBootScript, Toaster, TooltipProvider } from '@repo/ui'
import { QueryProvider } from '@/providers/QueryProvider'
import { ThemeProvider } from '@/providers/ThemeProvider'
import { WebStorageProvider } from '@/providers/WebStorageProvider'
import { ThemeKey } from '@/lib/constants'
import './globals.css'

/* 字体：**不接 next/font**，直接用 @repo/ui 定义的系统字体栈（2026-11-21 起）。
 * 理由：少一次外网字体下载（内网 / 离线部署更稳），且系统 UI 字体与中文本来就是同一套光学尺寸。 */
export const metadata: Metadata = {
  title: 'Billy CLI - 开箱即用的 AI 应用开发',
  description:
    '会话、流式、工具、模型、审计都已就位，改改就是你的 AI 产品；可观测性、设计系统与分层约束一并开箱。基于 NestJS 12 与 Next.js 16 的 AI 应用开发基座。',
}

/** 前端根 layout 统一动态渲染（每次请求 SSR，不做整站静态预渲染）。 */
export const dynamic = 'force-dynamic'

/**
 * 主题引导脚本（生成器在 `@repo/ui`）：在 React 水合前根据 localStorage / 系统偏好设置 .dark，
 * 避免深色模式刷新时白屏闪烁（FOUC）。key 用前台自己的，与后台互不干扰。
 */
const themeBootScript = createThemeBootScript({ storageKey: ThemeKey })

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen bg-background font-sans antialiased">
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        <ThemeProvider>
          <QueryProvider>
            <WebStorageProvider>
              <TooltipProvider>{children}</TooltipProvider>
            </WebStorageProvider>
          </QueryProvider>
        </ThemeProvider>
        {/* 全局 toast 容器：TanStack Query 的统一错误提示 / 页面操作反馈都经它渲染 */}
        <Toaster />
      </body>
    </html>
  )
}
