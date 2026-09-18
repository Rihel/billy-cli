import type { Metadata } from "next"
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google"
import { createThemeBootScript, Toaster, TooltipProvider } from "@repo/ui"
import { QueryProvider } from "@/providers/QueryProvider"
import { ThemeProvider } from "@/providers/ThemeProvider"
import { WebStorageProvider } from "@/providers/WebStorageProvider"
import { ThemeKey } from "@/lib/constants"
import "./globals.css"

/* 字体接线：下面三个变量名必须**写成字面量** —— next/font 的加载器要求编译期可静态分析的值，
 * 传变量会构建失败（Font loader values must be explicitly written literals）。
 * 变量名的契约在 @repo/ui/fonts，由 `pnpm check:ui` 校验这里与契约一致；
 * 族回退链定义在 ui 包的 globals.css 里，由 packages/ui/test/tokens.test.ts 守卫。 */
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

/**
 * 主题引导脚本（生成器在 `@repo/ui`）：在 React 水合前根据 localStorage / 系统偏好设置 .dark，
 * 避免深色模式刷新时白屏闪烁（FOUC）。key 用前台自己的，与后台互不干扰。
 */
const themeBootScript = createThemeBootScript({ storageKey: ThemeKey })

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
