import Link from 'next/link'
import { Reveal } from './reveal'

/** 竞品对比：只列真正对标的「全栈模板」，免费与收费各一行，数据以 GitHub 为准 */
const rivals = [
  {
    rival: '免费全栈模板',
    examples: 'Open SaaS（约 1.6 万 star）· Ixartz SaaS-Boilerplate（约 7400 star）',
    their: 'Open SaaS 同样 AI-ready（AGENTS.md + skills），但绑定 Wasp 声明式 DSL、单体 SaaS 形态；Ixartz 无 AI。',
    ours: '标准 TypeScript monorepo，通用工程基座：任意业务、双前端、用户 / 管理员双体系，而非单一 SaaS 产品。',
  },
  {
    rival: '收费 SaaS 模板',
    examples: 'Makerkit（$349）· Gravity（$199 起）· ShipFast（$199 起）· Supastarter（$299 起）',
    their: '全栈且带 agent 规则，但绑定 B2B 多租户 SaaS 场景，闭源付费。',
    ours: '免费开源、不绑定 SaaS 场景，另带监控告警、SSE、队列、对象存储等基建能力。',
  },
  {
    rival: '国内脚手架',
    examples: 'RuoYi（约 8500 star）· yudao-cloud（约 1.9 万 star）',
    their: 'Java + Vue 为主，功能全但无 AI 原生开发（AI 是产品功能或缺失）。',
    ours: 'TypeScript 全栈 + 15 个 skill 驱动，AI 按你的规范全链路交付。',
  },
]

/** 技术栈选型：选了谁、而不是谁、为什么 */
const stackChoices = [
  {
    picked: 'Hono 4',
    instead: '而不是 NestJS',
    reason: 'HTTP 层只做校验与转发，业务模块不依赖框架。薄边界可替换、可测试，框架不侵入业务。',
  },
  {
    picked: 'PostgreSQL',
    instead: '而不是 MySQL',
    reason: '告警规则存 jsonb、时间用 timestamptz，半结构化数据更自然，TypeORM 对 PG 支持也最成熟。',
  },
  {
    picked: 'TypeORM',
    instead: '而不是 Prisma',
    reason: '装饰器实体加 Repository，可注入、可 mock、可测试，与依赖注入天然契合。',
  },
  {
    picked: 'Next.js 16',
    instead: '而不是 Vite SPA',
    reason: 'RSC 加 SSR 加 Server Actions，前台后台同构，C 端页面可 SEO。',
  },
  {
    picked: 'Base UI + shadcn',
    instead: '而不是纯 Radix',
    reason: 'Base UI 由 Radix 团队打造，无样式原语配 Tailwind 4，shadcn 补齐可定制组件。',
  },
  {
    picked: 'Redis + BullMQ + croner',
    instead: '而不是各自为战',
    reason: '缓存、分布式锁、队列、定时任务、跨实例 SSE，一套 Redis 全部扛下。',
  },
]

/** 选型：凭什么选 Billy + 技术栈为什么这么选 */
export function Choice() {
  return (
    <section id="choice" className="scroll-mt-20 border-t border-zinc-200/70 bg-zinc-50">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        {/* 头部 */}
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-widest text-orange-600">选型</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
            凭什么选 Billy
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-zinc-600">
            免费的有 Open SaaS、Ixartz，收费的有 Makerkit、Gravity、Supastarter。
            Open SaaS 同样 AI-ready，Billy 的差别在：通用 TS monorepo 而非 Wasp DSL 单体、
            任意业务而非单一 SaaS、免费开源而非付费垂直。
          </p>
          <Link
            href="/comparison"
            className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-orange-700 hover:text-orange-600"
          >
            查看完整竞品调研 <span aria-hidden>→</span>
          </Link>
        </Reveal>

        {/* 01 · 竞品对比 */}
        <div className="mt-14">
          {rivals.map((item, i) => (
            <Reveal key={item.rival} delay={i * 40}>
              <div className="grid gap-3 border-t border-zinc-200 py-7 md:grid-cols-[1fr_1.2fr_1.2fr] md:gap-8">
                <div>
                  <p className="text-sm font-medium text-zinc-950">{item.rival}</p>
                  <p className="mt-1 font-mono text-xs text-zinc-400">{item.examples}</p>
                </div>
                <p className="text-sm leading-relaxed text-zinc-500">{item.their}</p>
                <p className="text-sm leading-relaxed text-zinc-700">{item.ours}</p>
              </div>
            </Reveal>
          ))}
          <div className="border-t border-zinc-200" aria-hidden />
        </div>

        {/* 02 · 技术栈选型 */}
        <Reveal delay={40}>
          <p className="mt-14 text-sm font-medium text-zinc-500">技术栈为什么这么选</p>
        </Reveal>
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {stackChoices.map((item, i) => (
            <Reveal key={item.picked} delay={i * 40}>
              <div className="h-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40">
                <h3 className="text-base font-semibold text-zinc-950">{item.picked}</h3>
                <p className="mt-1 text-xs text-zinc-400">{item.instead}</p>
                <p className="mt-3 text-sm leading-relaxed text-zinc-600">{item.reason}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
