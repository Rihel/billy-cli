import {
  Layers,
  Braces,
  MonitorSmartphone,
  Binary,
  PackageOpen,
  Container,
} from 'lucide-react'
import { Reveal } from './reveal'

/** 分层架构 mini 示意图（浅色行卡） */
function ArchitectureDiagram() {
  const rows = [
    { label: 'apps/server', sub: 'NestJS 边界 + 业务模块 + 实体迁移', level: '顶层' },
    { label: '@repo/kits', sub: '后端通用能力（数据库/缓存/队列/存储/推送）', level: '中层' },
    { label: '@repo/shared · sdk', sub: '数据结构 / 客户端', level: '底层' },
  ]
  return (
    <div className="mt-6 space-y-2">
      {rows.map((row, i) => (
        <div
          key={row.label}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 transition-colors hover:border-indigo-500/40"
        >
          <div className="flex items-center gap-3">
            <span
              className={`flex size-7 items-center justify-center rounded-lg font-mono text-[11px] font-semibold ${
                i === 0
                  ? 'bg-indigo-500/10 text-indigo-700'
                  : 'bg-zinc-100 text-zinc-500'
              }`}
            >
              {['01', '02', '03'][i]}
            </span>
            <div>
              <p className="font-mono text-sm text-zinc-900">{row.label}</p>
              <p className="text-xs text-zinc-500">{row.sub}</p>
            </div>
          </div>
          <span className="hidden font-mono text-[11px] text-zinc-400 sm:block">{row.level}</span>
        </div>
      ))}
    </div>
  )
}

/** Zod 数据结构 mini 片段（浅色代码块） */
function ZodSnippet() {
  return (
    <pre className="mt-6 overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4 font-mono text-xs leading-6">
      <span className="text-zinc-500">const</span> <span className="text-zinc-800">TodoSchema</span>{' '}
      <span className="text-zinc-500">=</span> z.<span className="text-indigo-600">object</span>
      {'({'}
      {'\n  '}
      <span className="text-zinc-700">title</span>: z.<span className="text-indigo-600">string</span>(),
      {'\n  '}
      <span className="text-zinc-700">completed</span>: z.
      <span className="text-indigo-600">boolean</span>().<span className="text-indigo-600">default</span>
      (<span className="text-zinc-800">false</span>),
      {'\n'}
      {'})'}
    </pre>
  )
}

const smallCells = [
  {
    icon: Braces,
    title: '数据结构先行',
    desc: '数据结构只定义一份，后端校验、数据库、前端表单全部共用，字段永远对得上。',
  },
  {
    icon: MonitorSmartphone,
    title: '双前端开箱',
    desc: 'Web 前台用 Base UI + shadcn，Admin 后台用 TanStack Table / Form，统一共享 @repo/ui 组件库。',
  },
  {
    icon: Binary,
    title: '全类型 SDK',
    desc: '在 HttpClient 之上封装全类型化 ServerClient，前端调用接口全程类型提示，杜绝魔法字符串。',
  },
  {
    icon: Container,
    title: '容器化部署',
    desc: 'Docker multi-stage 构建，server 与 web 独立镜像，compose 一键拉起 PostgreSQL、Redis 与 MinIO。',
  },
]

/** 特性 Bento 网格 */
export function Features() {
  return (
    <section id="features" className="scroll-mt-20 border-t border-zinc-200/70 bg-zinc-50/60">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        {/* 头部：非对称（标题大 + 右列编号与说明） */}
        <Reveal>
          <div className="lg:grid lg:grid-cols-[1.5fr_1fr] lg:items-end lg:gap-16">
            <div>
              <div className="flex items-center gap-3">
                <span className="h-px w-8 bg-indigo-500" aria-hidden />
                <p className="font-mono text-xs font-medium tracking-[0.18em] text-indigo-600 uppercase">
                  特性
                </p>
              </div>
              <h2 className="font-heading mt-4 max-w-xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl md:text-5xl">
                把架构决策做好，剩下的交给模板
              </h2>
            </div>
            <div className="mt-5 max-w-sm border-l-2 border-zinc-200 pl-6 lg:mt-0 lg:border-l-0 lg:border-t lg:pt-6 lg:pl-0">
              <p className="text-base leading-relaxed text-zinc-600">
                不是玩具脚手架，而是一套能直接承载真实业务的全栈工程基座。
              </p>
            </div>
          </div>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {/* 大 cell：分层架构 */}
          <Reveal className="md:col-span-2" delay={60}>
            <div className="group relative h-full overflow-hidden rounded-xl border border-zinc-200 bg-white p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/60 hover:shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-700">
                  <Layers className="size-4.5" />
                </span>
                <h3 className="text-lg font-semibold text-zinc-950">分层架构，依赖方向不可逆</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                薄边界 + 业务核心：controller 只做校验与转发，业务下沉 apps/server 模块层，能力复用 @repo/kits，单向依赖、职责清晰、可测试。
              </p>
              <ArchitectureDiagram />
            </div>
          </Reveal>

          {/* 小 cell：数据结构先行 */}
          <Reveal delay={120}>
            <div className="group relative h-full overflow-hidden rounded-xl border border-zinc-200 bg-white p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/60 hover:shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-indigo-700">
                  <Braces className="size-4.5" />
                </span>
                <h3 className="text-base font-semibold text-zinc-950">数据结构先行</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                数据结构只定义一份，后端校验、数据库、前端共用，字段永远对得上。
              </p>
              <ZodSnippet />
            </div>
          </Reveal>

          {/* 小 cell：双前端 */}
          <Reveal delay={40}>
            <FeatureCell {...smallCells[1]} />
          </Reveal>
          {/* 小 cell：全类型 SDK */}
          <Reveal delay={100}>
            <FeatureCell {...smallCells[2]} />
          </Reveal>

          {/* 大 cell：开箱即用模块 */}
          <Reveal className="md:col-span-2" delay={60}>
            <div className="group relative h-full overflow-hidden rounded-xl border border-indigo-200/70 bg-gradient-to-b from-indigo-50/60 to-white p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/60 hover:shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-700">
                  <PackageOpen className="size-4.5" />
                </span>
                <h3 className="text-lg font-semibold text-zinc-950">开箱即用的业务模块</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                认证、用户、待办等完整模块示例，覆盖数据结构、实体、服务、路由、页面全链路，照着抄就能扩展新业务。
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {['认证鉴权', '用户体系', '待办事项', '管理员', '字典枚举', '对象存储', '实时推送', '监控告警'].map((m) => (
                  <span
                    key={m}
                    className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 text-xs text-zinc-600"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>

          {/* 小 cell：容器化 */}
          <Reveal delay={140}>
            <FeatureCell {...smallCells[3]} />
          </Reveal>
        </div>
      </div>
    </section>
  )
}

function FeatureCell({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof Layers
  title: string
  desc: string
}) {
  return (
    <div className="group relative h-full overflow-hidden rounded-xl border border-zinc-200 bg-white p-6 transition-all hover:-translate-y-0.5 hover:border-indigo-400/60 hover:shadow-sm">
      <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-indigo-700">
        <Icon className="size-4.5" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-zinc-950">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{desc}</p>
    </div>
  )
}
