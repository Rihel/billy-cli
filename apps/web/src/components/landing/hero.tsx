import Link from 'next/link'
import { ArrowRight, LogIn } from 'lucide-react'
import { Button } from '@repo/ui'
import { Pages } from '@/lib/constants'
import type { AuthUserModel } from '@repo/shared'

const heroFacts = [
  { k: '17', v: 'Agent Skills' },
  { k: '2', v: '前端应用' },
  { k: '1', v: '数据结构' },
]

export type HeroProps = {
  /** 服务端探测到的登录用户：已登录时隐藏「开始使用 / 登录」账号入口 */
  user: AuthUserModel | null
  /** 用户体系开关：关闭时不渲染任何账号入口（与 Header 同一约定） */
  authEnabled: boolean
}

/**
 * 首页主视觉：全屏沉浸式编辑宣言。
 * 无右侧终端卡；超大 display 标题 + 编排式事实行，靠浅色网格与蓝色氛围撑满首屏。
 */
export function Hero({ user, authEnabled }: HeroProps) {
  return (
    <section className="relative flex min-h-[calc(100dvh-4rem)] flex-col overflow-hidden">
      {/*
        背景：60 秒循环的「信号织物」。
        - 静音自动播放（浏览器只允许 muted 自动播），音轨保留，用户点开声音即可听配乐版；
        - `playsInline` 防止 iOS 全屏劫持；
        - 系统开启「减弱动态效果」时不加载视频，只显示同一帧的封面图。
        成片与制作说明见 opus-video/billy-hero-ambient/。
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

      {/* 主内容：纵向堆叠，巨型标题居左 */}
      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-4 py-20 sm:px-6 lg:px-8 lg:py-0">
        <div className="max-w-5xl">
          <div className="mb-8 flex items-center gap-3">
            <span className="h-px w-10 bg-brand" aria-hidden />
            <span className="font-mono text-xs font-medium tracking-[0.2em] text-brand uppercase">
              AI 原生全栈模板
            </span>
          </div>

          <h1 className="font-heading text-5xl leading-[1.02] font-bold tracking-tighter text-foreground sm:text-6xl md:text-7xl lg:text-8xl">
            AI 原生工程，
            <br />
            一套模板<span className="text-brand">全栈直达</span>
          </h1>

          <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
            工程规范写进 17 个 Agent Skills，AI 开工先读规范、按你的标准交付；
            NestJS 12 + Next.js 16 双前端开箱即用，pnpm bootstrap 一键初始化。
          </p>

          {/* 账号入口：仅「未登录且用户体系开启」时渲染（已登录用户由顶部导航承担用户信息与退出） */}
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

        {/* 编排式事实行（hairline 分隔，替代终端卡的节奏） */}
        <div className="mt-16 grid max-w-3xl grid-cols-3 gap-6 border-t border-border pt-8 sm:gap-10">
          {heroFacts.map((fact) => (
            <div key={fact.v}>
              <div className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                {fact.k}
              </div>
              <div className="mt-1 text-xs text-muted-foreground uppercase tracking-wider">
                {fact.v}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部 hairline 信息带 */}
      <div className="relative border-t border-border/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 font-mono text-[11px] tracking-wider text-muted-foreground uppercase sm:px-6 lg:px-8">
          <span>TypeScript monorepo</span>
          <span className="hidden sm:inline">NestJS · Next.js 16 · PostgreSQL · Redis</span>
          <span className="hidden text-success sm:inline">● ready</span>
        </div>
      </div>
    </section>
  )
}
