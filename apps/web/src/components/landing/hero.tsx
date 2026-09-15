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
      {/* 背景：细网格（顶部集中）+ 双光斑 */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(to_right,rgb(9_9_11/0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgb(9_9_11/0.04)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_75%_70%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden
        className="absolute -top-40 left-1/2 h-[30rem] w-[52rem] max-w-none -translate-x-1/2 rounded-full bg-indigo-500/10 blur-3xl motion-safe:animate-[drift_18s_ease-in-out_infinite]"
      />
      <div
        aria-hidden
        className="absolute top-1/3 -right-32 size-[28rem] rounded-full bg-indigo-400/10 blur-3xl motion-safe:animate-[glow_10s_ease-in-out_infinite]"
      />

      {/* 主内容：纵向堆叠，巨型标题居左 */}
      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-4 py-20 sm:px-6 lg:px-8 lg:py-0">
        <div className="max-w-5xl">
          <div className="mb-8 flex items-center gap-3">
            <span className="h-px w-10 bg-indigo-500" aria-hidden />
            <span className="font-mono text-xs font-medium tracking-[0.2em] text-indigo-600 uppercase">
              AI 原生全栈模板
            </span>
          </div>

          <h1 className="font-heading text-5xl leading-[1.02] font-bold tracking-tighter text-zinc-950 sm:text-6xl md:text-7xl lg:text-8xl">
            AI 原生工程，
            <br />
            一套模板<span className="text-indigo-600">全栈直达</span>
          </h1>

          <p className="mt-8 max-w-2xl text-lg leading-relaxed text-zinc-600 sm:text-xl">
            工程规范写进 17 个 Agent Skills，AI 开工先读规范、按你的标准交付；
            NestJS 12 + Next.js 16 双前端开箱即用，pnpm bootstrap 一键初始化。
          </p>

          {/* 账号入口：仅「未登录且用户体系开启」时渲染（已登录用户由顶部导航承担用户信息与退出） */}
          {user || !authEnabled ? null : (
            <div className="mt-10 flex flex-wrap items-center gap-3">
              <Button
                render={<Link href={Pages.register} />}
                size="lg"
                className="bg-zinc-950 text-white shadow-lg shadow-zinc-950/20 hover:bg-zinc-800"
              >
                开始使用
                <ArrowRight data-icon="inline-end" />
              </Button>
              <Button
                render={<Link href={Pages.login} />}
                size="lg"
                variant="outline"
                className="border-zinc-300 bg-white px-5 text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900"
              >
                <LogIn data-icon="inline-start" />
                登录
              </Button>
            </div>
          )}
        </div>

        {/* 编排式事实行（hairline 分隔，替代终端卡的节奏） */}
        <div className="mt-16 grid max-w-3xl grid-cols-3 gap-6 border-t border-zinc-200 pt-8 sm:gap-10">
          {heroFacts.map((fact) => (
            <div key={fact.v}>
              <div className="font-heading text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
                {fact.k}
              </div>
              <div className="mt-1 text-xs text-zinc-500 uppercase tracking-wider">
                {fact.v}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部 hairline 信息带 */}
      <div className="relative border-t border-zinc-200/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 font-mono text-[11px] tracking-wider text-zinc-400 uppercase sm:px-6 lg:px-8">
          <span>TypeScript monorepo</span>
          <span className="hidden sm:inline">NestJS · Next.js 16 · PostgreSQL · Redis</span>
          <span className="hidden text-emerald-600 sm:inline">● ready</span>
        </div>
      </div>
    </section>
  )
}
