'use client'

import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui'
import { competitors, type Competitor } from '@/lib/competitors'

function Flag({ label, ok }: { label: string; ok: boolean }) {
  return (
    <span
      className={
        ok
          ? 'inline-flex items-center gap-1.5 rounded-lg border border-orange-500/30 bg-orange-500/10 px-2.5 py-1 text-xs font-medium text-orange-700'
          : 'inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 py-1 text-xs text-zinc-500'
      }
    >
      <span className={ok ? 'text-orange-600' : 'text-zinc-400'}>{ok ? '✓' : '✕'}</span>
      {label}
    </span>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mt-0.5 text-sm text-zinc-700">{value}</p>
    </div>
  )
}

function CompetitorCard({ c }: { c: Competitor }) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm shadow-zinc-200/50">
      <div className="flex items-center justify-between gap-3">
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1.5 text-base font-semibold text-zinc-950 hover:text-orange-600"
        >
          {c.name}
          <ExternalLink className="size-3.5 text-zinc-400 transition-colors group-hover:text-orange-600" />
        </a>
        <span
          className={
            c.paid
              ? 'rounded-full border border-zinc-200 bg-zinc-50 px-2.5 py-0.5 text-xs text-zinc-600'
              : 'rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-700'
          }
        >
          {c.paid ? '收费商业' : '免费开源'}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Flag label="全栈模板" ok={c.isFullstack} />
        <Flag label="AI 能力" ok={c.ai} />
      </div>

      <p className="mt-3 text-sm text-zinc-600">
        <span className="text-zinc-400">形态：</span>
        {c.form}
      </p>
      <p className="mt-1.5 text-sm text-zinc-600">
        <span className="text-zinc-400">AI 能力：</span>
        {c.aiNote}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-zinc-100 pt-4">
        <Meta label="规模 / 价格" value={c.metric} />
        <Meta label="维护" value={c.maintenance} />
        <Meta label="issues" value={c.issues} />
        <Meta label="真实案例" value={c.cases} />
      </div>

      <p className="mt-4 border-t border-zinc-100 pt-4 text-sm leading-relaxed text-zinc-600">
        {c.summary}
      </p>
    </div>
  )
}

function CardGrid({ items }: { items: Competitor[] }) {
  return (
    <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
      {items.map((c) => (
        <CompetitorCard key={c.name} c={c} />
      ))}
    </div>
  )
}

export default function ComparisonPage() {
  const overseas = competitors.filter((c) => c.region === '海外')
  const domesticFullstack = competitors.filter((c) => c.region === '国内' && c.isFullstack)
  const domesticFrontend = competitors.filter((c) => c.region === '国内' && !c.isFullstack)

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <header className="border-b border-zinc-200/80 bg-white">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm text-zinc-600 hover:text-zinc-900">
            ← 返回首页
          </Link>
          <span className="font-mono text-xs text-zinc-400">Billy CLI · 竞品调研</span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <p className="text-xs font-medium uppercase tracking-widest text-orange-600">
          竞品调研
        </p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
          同类模板，逐一核实
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-relaxed text-zinc-600">
          调研日期 2026-09-02，数据以 GitHub 为准；star 与价格会随时间变化。
          仅收录「模板 / 脚手架」类，纯技术框架（Wasp / RedwoodJS / Midway）、工具与工作流已剔除。
        </p>

        {/* 筛选标准 */}
        <div className="mt-8 rounded-2xl border border-zinc-200 bg-white p-6">
          <p className="text-sm font-medium text-zinc-950">为什么是这些竞品</p>
          <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-zinc-600 md:grid-cols-2">
            <li>① 只收「模板 / 脚手架」：clone 即用的前后端骨架，剔除框架、创建器、工作流、技能包。</li>
            <li>② AI 能力：是否内置 AGENTS.md / skills / agent，这是 Billy 的核心卖点。</li>
            <li>③ star 过千：有真实社区验证，排除 0 star 的新仓库。</li>
            <li>④ 案例 + 维护 + issues：是否有真实使用、是否还在维护、问题是否有人处理。</li>
          </ul>
        </div>

        {/* 多层级 Tab */}
        <div className="mt-12">
          <Tabs defaultValue="overseas">
            <TabsList>
              <TabsTrigger value="overseas">海外（{overseas.length}）</TabsTrigger>
              <TabsTrigger value="domestic">国内（{domesticFullstack.length + domesticFrontend.length}）</TabsTrigger>
            </TabsList>

            <TabsContent value="overseas" className="mt-6">
              <p className="text-sm font-medium text-zinc-500">海外 · 收费商业（{overseas.length}）</p>
              <CardGrid items={overseas} />
            </TabsContent>

            <TabsContent value="domestic" className="mt-6">
              <Tabs defaultValue="fullstack">
                <TabsList>
                  <TabsTrigger value="fullstack">全栈脚手架（{domesticFullstack.length}）</TabsTrigger>
                  <TabsTrigger value="frontend">前端模板（{domesticFrontend.length}）</TabsTrigger>
                </TabsList>
                <TabsContent value="fullstack" className="mt-4">
                  <CardGrid items={domesticFullstack} />
                </TabsContent>
                <TabsContent value="frontend" className="mt-4">
                  <CardGrid items={domesticFrontend} />
                </TabsContent>
              </Tabs>
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  )
}
