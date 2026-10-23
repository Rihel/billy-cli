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
          ? 'inline-flex items-center gap-1.5 rounded-lg border border-brand/30 bg-brand/10 px-2.5 py-1 text-xs font-medium text-brand'
          : 'inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs text-muted-foreground'
      }
    >
      <span className={ok ? 'text-brand' : 'text-muted-foreground'}>{ok ? '✓' : '✕'}</span>
      {label}
    </span>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-sm text-foreground">{value}</p>
    </div>
  )
}

function CompetitorCard({ c }: { c: Competitor }) {
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-brand/60 hover:shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <a
          href={c.url}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1.5 text-base font-semibold text-foreground hover:text-brand"
        >
          {c.name}
          <ExternalLink className="size-3.5 text-muted-foreground transition-colors group-hover:text-brand" />
        </a>
        <span
          className={
            c.paid
              ? 'rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground'
              : 'rounded-full border border-success/20 bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success'
          }
        >
          {c.paid ? '收费商业' : '免费开源'}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Flag label="全栈模板" ok={c.isFullstack} />
        <Flag label="AI 能力" ok={c.ai} />
      </div>

      <p className="mt-3 text-sm text-muted-foreground">
        <span className="text-muted-foreground">形态：</span>
        {c.form}
      </p>
      <p className="mt-1.5 text-sm text-muted-foreground">
        <span className="text-muted-foreground">AI 能力：</span>
        {c.aiNote}
      </p>

      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-4">
        <Meta label="规模 / 价格" value={c.metric} />
        <Meta label="维护" value={c.maintenance} />
        <Meta label="issues" value={c.issues} />
        <Meta label="真实案例" value={c.cases} />
      </div>

      <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
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
  const overseasFree = competitors.filter((c) => c.region === '海外' && !c.paid)
  const overseasPaid = competitors.filter((c) => c.region === '海外' && c.paid)
  const domesticFullstack = competitors.filter((c) => c.region === '国内' && c.isFullstack)
  const domesticFrontend = competitors.filter((c) => c.region === '国内' && !c.isFullstack)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80 bg-card">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">
            ← 返回首页
          </Link>
          <span className="font-mono text-xs text-muted-foreground">Billy CLI · 竞品调研</span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div className="flex items-center gap-3">
          <span className="h-px w-8 bg-brand" aria-hidden />
          <p className="font-mono text-xs font-medium tracking-[0.18em] text-brand uppercase">
            竞品调研
          </p>
        </div>
        <h1 className="font-heading mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl md:text-5xl">
          同类模板，逐一核实
        </h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-muted-foreground">
          调研日期 2026-09-02（2026-10-23 复核），数据以 GitHub 为准；star 与价格会随时间变化。
          仅收录「模板 / 脚手架」类，纯技术框架（Wasp / RedwoodJS / Midway）、工具与工作流已剔除。
          AI 应用框架（Mastra / Dify / LangGraph）单列一条赛道：它们给运行时零件，不给业务基座。
        </p>

        {/* 筛选标准 */}
        <div className="mt-8 rounded-xl border border-border bg-card p-6">
          <p className="text-sm font-medium text-foreground">为什么是这些竞品</p>
          <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-muted-foreground md:grid-cols-2">
            <li>① 只收「模板 / 脚手架」：clone 即用的前后端骨架，剔除框架、创建器、工作流、技能包。</li>
            <li>② AI 能力：是否内置 AGENTS.md / skills / agent，这是 Billy 的核心卖点。</li>
            <li>③ star 过千：有真实社区验证，排除 0 star 的新仓库。</li>
            <li>④ 案例 + 维护 + issues：是否有真实使用、是否还在维护、问题是否有人处理。</li>
          </ul>
        </div>

        {/* 多层级 Tab */}
        <div className="mt-12">
          <Tabs defaultValue="overseas">
            <TabsList variant="line">
              <TabsTrigger value="overseas">海外（{overseasFree.length + overseasPaid.length}）</TabsTrigger>
              <TabsTrigger value="domestic">国内（{domesticFullstack.length + domesticFrontend.length}）</TabsTrigger>
            </TabsList>

            <TabsContent value="overseas" className="mt-6">
              <Tabs defaultValue="free">
                <TabsList variant="line">
                  <TabsTrigger value="free">免费开源（{overseasFree.length}）</TabsTrigger>
                  <TabsTrigger value="paid">收费商业（{overseasPaid.length}）</TabsTrigger>
                </TabsList>
                <TabsContent value="free" className="mt-4">
                  <CardGrid items={overseasFree} />
                </TabsContent>
                <TabsContent value="paid" className="mt-4">
                  <CardGrid items={overseasPaid} />
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="domestic" className="mt-6">
              <Tabs defaultValue="fullstack">
                <TabsList variant="line">
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
