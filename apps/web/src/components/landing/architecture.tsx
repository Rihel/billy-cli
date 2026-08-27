import { ArrowRight, Server, Code2, DatabaseZap, Workflow, ShieldCheck } from 'lucide-react'
import { Reveal } from './reveal'

const steps = [
  {
    icon: Code2,
    tag: '@repo/sdk',
    title: '前端调用',
    desc: 'ServerClient 全类型化方法发起请求',
  },
  {
    icon: Server,
    tag: 'apps/server',
    title: 'Hono 边界',
    desc: 'Zod 校验请求体，薄边界零业务',
  },
  {
    icon: Workflow,
    tag: 'apps/server/src/modules',
    title: '业务核心',
    desc: 'Service + Repository（@repo/di 注入）',
  },
  {
    icon: DatabaseZap,
    tag: '@repo/kits',
    title: '能力底座',
    desc: 'TypeORM 门面 + 分页 + 事务 + 存储',
  },
]

const rules = [
  'shared 不依赖任何业务包',
  'kits 不引用 apps/*',
  'modules 不 import Hono',
]

/** 架构说明：一次请求的数据流 */
export function Architecture() {
  return (
    <section id="architecture" className="scroll-mt-20">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-widest text-orange-600">架构</p>
          <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
            一次请求，四层各司其职
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-zinc-600">
            数据流自底向上设计、自顶向下调用，每一层边界清晰，替换与测试都从容。
          </p>
        </Reveal>

        <Reveal delay={80}>
          <div className="mt-12 grid gap-3 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] lg:items-stretch">
            {steps.map((step, i) => (
              <div key={step.title} className="contents">
                <div className="group relative overflow-hidden rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40">
                  <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-orange-700">
                    <step.icon className="size-4.5" />
                  </span>
                  <p className="mt-4 font-mono text-xs text-orange-700">{step.tag}</p>
                  <h3 className="mt-1 text-base font-semibold text-zinc-950">{step.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-zinc-600">{step.desc}</p>
                </div>
                {i < steps.length - 1 && (
                  <div className="flex items-center justify-center py-1 lg:py-0">
                    <ArrowRight className="size-5 rotate-90 text-zinc-400 lg:rotate-0" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={140}>
          <div className="mt-8 flex flex-wrap items-center gap-3 rounded-2xl border border-orange-500/20 bg-orange-500/[0.06] px-5 py-4">
            <ShieldCheck className="size-5 shrink-0 text-orange-700" />
            <p className="text-sm text-zinc-700">依赖方向铁律：</p>
            <div className="flex flex-wrap gap-2">
              {rules.map((rule) => (
                <code
                  key={rule}
                  className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1 font-mono text-xs text-zinc-600"
                >
                  {rule}
                </code>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
