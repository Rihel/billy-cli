import { ShieldCheck } from 'lucide-react'
import { Reveal } from './reveal'

const steps = [
  {
    tag: '@repo/sdk',
    title: '前端调用',
    desc: 'ServerClient 全类型化方法发起请求',
  },
  {
    tag: 'apps/server',
    title: 'Hono 边界',
    desc: 'Zod 校验请求体，薄边界零业务',
  },
  {
    tag: 'apps/server/src/modules',
    title: '业务核心',
    desc: 'Service + Repository（@repo/di 注入）',
  },
  {
    tag: '@repo/kits',
    title: '能力底座',
    desc: 'TypeORM 底座 + 分页 + 事务 + 存储 + SSE 推送',
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
          <div className="flex items-center gap-3">
            <span className="h-px w-8 bg-indigo-500" aria-hidden />
            <p className="font-mono text-xs font-medium tracking-[0.18em] text-indigo-600 uppercase">
              架构
            </p>
          </div>
          <h2 className="font-heading mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl md:text-5xl">
            一次请求，四层各司其职
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-zinc-600">
            数据流自底向上设计、自顶向下调用，每一层边界清晰，替换与测试都从容。
          </p>
        </Reveal>

        <Reveal delay={80}>
          <div className="mt-14 max-w-3xl">
            {steps.map((step, i) => (
              <div key={step.title} className="flex gap-6 border-t border-zinc-200 py-7 first:border-t-0 md:gap-10">
                <span className="font-heading w-10 shrink-0 text-2xl font-semibold tracking-tight text-indigo-600/60">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h3 className="font-heading text-xl font-semibold tracking-tight text-zinc-950">
                      {step.title}
                    </h3>
                    <span className="font-mono text-xs text-indigo-700">{step.tag}</span>
                  </div>
                  <p className="mt-2 max-w-xl text-base leading-relaxed text-zinc-600">
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={140}>
          <div className="mt-10 flex flex-wrap items-center gap-3 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.06] px-5 py-4">
            <ShieldCheck className="size-5 shrink-0 text-indigo-700" />
            <p className="text-sm text-zinc-700">依赖方向规范：</p>
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
