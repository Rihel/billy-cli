import Link from 'next/link'
import { ArrowRight, LogIn } from 'lucide-react'
import { Button } from '@repo/ui'
import { Pages } from '@/lib/constants'
import type { AuthUserModel } from '@repo/shared'

export type HeroProps = {
  /** 服务端探测到的登录用户：已登录时隐藏「开始使用 / 登录」账号入口 */
  user: AuthUserModel | null
  /** 用户体系开关：关闭时不渲染任何账号入口（与 Header 同一约定） */
  authEnabled: boolean
}

/**
 * 首页主视觉：全屏沉浸式编辑宣言。
 * 只放四个元素：眉标、两行标题、一句说明、账号入口；事实数字交给下方横带。
 */
export function Hero({ user, authEnabled }: HeroProps) {
  return (
    <section className="relative flex min-h-[calc(100dvh-4rem)] flex-col overflow-hidden">
      {/*
        背景：60 秒循环的「信号织物」。
        - 静音自动播放（浏览器只允许 muted 自动播），音轨保留，用户点开声音即可听配乐版；
        - `playsInline` 防止 iOS 全屏劫持；
        - 系统开启「减弱动态效果」时不加载视频，只显示同一帧的封面图。
        成片在 `public/hero/`；制作工程属本地产物，不入库（见 .gitignore）。
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden [mask-image:radial-gradient(ellipse_88%_82%_at_56%_38%,black,transparent)]"
      >
        <video
          className="absolute inset-0 size-full object-cover motion-reduce:hidden"
          poster="/hero/scaffold-hero.jpg"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
        >
          <source src="/hero/scaffold-hero.mp4" type="video/mp4" />
        </video>
        <img
          src="/hero/scaffold-hero.jpg"
          alt=""
          className="absolute inset-0 hidden size-full object-cover motion-reduce:block"
        />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-4 py-24 sm:px-6 lg:px-8">
        <div className="max-w-4xl">
          <div className="mb-8 flex items-center gap-3">
            <span className="h-px w-10 bg-brand" aria-hidden />
            <span className="font-mono text-xs font-medium tracking-[0.2em] text-brand uppercase">
              开箱即用的 AI 应用开发
            </span>
          </div>

          <h1 className="font-heading text-5xl leading-[1.04] font-bold tracking-tighter text-foreground sm:text-6xl md:text-7xl">
            别再从零搭
            <br />
            <span className="text-brand">一个 AI 应用</span>
          </h1>

          <p className="mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            会话、流式、工具、模型、审计都已就位，改改就是你的产品。
          </p>

          {user || !authEnabled ? null : (
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button
                render={<Link href={Pages.register} />}
                size="lg"
                className="bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
              >
                开始使用
                <ArrowRight data-icon="inline-end" />
              </Button>
              <Button
                render={<Link href={Pages.login} />}
                size="lg"
                variant="outline"
                className="border-border bg-card px-5 text-foreground hover:bg-muted hover:text-foreground"
              >
                <LogIn data-icon="inline-start" />
                登录
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
