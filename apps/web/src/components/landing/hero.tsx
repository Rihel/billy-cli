import Link from 'next/link'
import { ArrowRight, Sparkles, LogIn } from 'lucide-react'
import { Button } from '@repo/ui'
import { Pages } from '@/lib/constants'

type TerminalLine =
  | { kind: 'prompt'; text: string }
  | { kind: 'ai'; text: string }
  | { kind: 'check'; text: string }
  | { kind: 'ready'; text: string }

const terminalLines: TerminalLine[] = [
  { kind: 'prompt', text: 'billy --ai "新增一个商品模块"' },
  { kind: 'ai', text: '加载 develop-business-module 技能' },
  { kind: 'check', text: '契约 → 实体 → 服务 → 路由 → SDK' },
  { kind: 'check', text: '后台页面已登记菜单' },
  { kind: 'check', text: '交付检查清单全部通过' },
  { kind: 'ready', text: 'ready · http://localhost:9840' },
]

/** 首页主视觉：AI 原生价值主张 + 右侧 AI 编码会话终端卡（深色对比块） */
export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* 背景：浅色网格 + 橙色光斑 */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(to_right,rgb(9_9_11/0.045)_1px,transparent_1px),linear-gradient(to_bottom,rgb(9_9_11/0.045)_1px,transparent_1px)] bg-[size:52px_52px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden
        className="absolute -top-32 left-1/2 h-105 w-150 -translate-x-1/2 rounded-full bg-orange-500/10 blur-3xl motion-safe:animate-[drift_16s_ease-in-out_infinite]"
      />
      <div
        aria-hidden
        className="absolute top-40 -right-24 size-96 rounded-full bg-orange-500/10 blur-3xl motion-safe:animate-[glow_9s_ease-in-out_infinite]"
      />

      <div className="relative mx-auto grid max-w-7xl grid-cols-1 items-center gap-14 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:pb-28 lg:pt-24">
        {/* 左侧文案 */}
        <div className="max-w-xl">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-orange-500/25 bg-orange-500/10 px-3.5 py-1.5 text-xs font-medium text-orange-700">
            <Sparkles className="size-3.5" />
            AI 原生全栈模板
          </div>

          <h1 className="text-3xl font-semibold leading-[1.12] tracking-tight text-zinc-950 sm:text-4xl md:text-5xl lg:text-6xl">
            AI 原生工程，
            <br />
            一套模板<span className="text-orange-600">全栈直达</span>
          </h1>

          <p className="mt-6 max-w-md text-base leading-relaxed text-zinc-600 sm:text-lg">
            内置 14 个 Agent Skills，AI 按你的工程规范全链路交付；Hono + Next.js 16 双前端，一条命令跑起来。
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Button
              render={<Link href={Pages.register} />}
              size="lg"
              className="bg-orange-500 px-5 text-white shadow-lg shadow-orange-500/25 hover:bg-orange-600"
            >
              开始使用
              <ArrowRight data-icon="inline-end" />
            </Button>
            <Button
              render={<Link href={Pages.login} />}
              size="lg"
              variant="outline"
              className="border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900"
            >
              <LogIn data-icon="inline-start" />
              登录
            </Button>
          </div>
        </div>

        {/* 右侧：AI 编码会话终端卡（深色对比块） */}
        <div className="relative">
          <div
            aria-hidden
            className="absolute -inset-6 rounded-3xl bg-gradient-to-br from-orange-500/10 via-transparent to-transparent blur-2xl"
          />
          <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-zinc-900/25">
            {/* 窗口标题栏 */}
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <span className="size-3 rounded-full bg-red-400/80" />
              <span className="size-3 rounded-full bg-amber-400/80" />
              <span className="size-3 rounded-full bg-emerald-400/80" />
              <span className="ml-2 font-mono text-xs text-zinc-500">
                billy-cli · AI 编码会话
              </span>
              <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-emerald-400/20 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                <span className="size-1.5 rounded-full bg-emerald-400 motion-safe:animate-pulse" />
                AI 在线
              </span>
            </div>
            {/* 会话输出 */}
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
              {terminalLines.map((line, i) => (
                <div key={i} className="whitespace-pre">
                  <span className="select-none text-zinc-700">
                    {String(i + 1).padStart(2, '0')}{' '}
                  </span>
                  {line.kind === 'prompt' && (
                    <>
                      <span className="text-emerald-400">$</span>{' '}
                      <span className="text-zinc-100">{line.text}</span>
                    </>
                  )}
                  {line.kind === 'ai' && (
                    <>
                      <span className="text-orange-400">[ai]</span>{' '}
                      <span className="text-zinc-300">{line.text}</span>{' '}
                      <span className="text-emerald-400">✓</span>
                    </>
                  )}
                  {line.kind === 'check' && (
                    <>
                      <span className="text-orange-400">[ai]</span>{' '}
                      <span className="text-zinc-400">✓</span>{' '}
                      <span className="text-zinc-500">{line.text}</span>
                    </>
                  )}
                  {line.kind === 'ready' && (
                    <>
                      <span className="text-emerald-400">➜</span>{' '}
                      <span className="text-zinc-200">{line.text}</span>
                      <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-orange-400" />
                    </>
                  )}
                </div>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </section>
  )
}
