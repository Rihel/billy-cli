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
    { label: 'apps/server', sub: 'Hono 边界 + 业务模块 + 实体迁移', level: '顶层' },
    { label: '@repo/kits', sub: '后端通用能力（数据库/缓存/队列/存储）', level: '中层' },
    { label: '@repo/shared · sdk', sub: '契约 / 客户端', level: '底层' },
  ]
  return (
    <div className="mt-6 space-y-2">
      {rows.map((row, i) => (
        <div
          key={row.label}
          className="flex items-center justify-between rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 transition-colors hover:border-orange-500/40"
        >
          <div className="flex items-center gap-3">
            <span
              className={`flex size-7 items-center justify-center rounded-lg font-mono text-[11px] font-semibold ${
                i === 0
                  ? 'bg-orange-500/10 text-orange-700'
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

/** Zod 契约 mini 片段（深色代码块对比） */
function ZodSnippet() {
  return (
    <pre className="mt-6 overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-6">
      <span className="text-zinc-500">const</span> <span className="text-zinc-200">TodoSchema</span>{' '}
      <span className="text-zinc-500">=</span> z.<span className="text-orange-400">object</span>
      {'({'}
      {'\n  '}
      <span className="text-zinc-300">title</span>: z.<span className="text-orange-400">string</span>(),
      {'\n  '}
      <span className="text-zinc-300">status</span>: <span className="text-zinc-200">TodoStatus</span>,
      {'\n'}
      {'})'}
    </pre>
  )
}

const smallCells = [
  {
    icon: Braces,
    title: '契约先行',
    desc: 'Zod Schema 定义一切，后端校验、数据库、前端表单共用同一份契约，字段永不失同步。',
  },
  {
    icon: MonitorSmartphone,
    title: '双前端开箱',
    desc: 'Web 前台（Base UI + shadcn）与 Admin 后台（Ant Design 6）两套入口独立构建，互不串用。',
  },
  {
    icon: Binary,
    title: '全类型 SDK',
    desc: '基于 HttpClient 生成全类型化 ServerClient，前端调用接口全程类型提示，杜绝魔法字符串。',
  },
  {
    icon: Container,
    title: '容器化部署',
    desc: 'Docker multi-stage 构建，server 与 web 独立镜像，compose 一键拉起 PostgreSQL 与 Redis。',
  },
]

/** 特性 Bento 网格 */
export function Features() {
  return (
    <section id="features" className="scroll-mt-20">
      <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-widest text-orange-600">
            特性
          </p>
          <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
            把架构决策做好，剩下的交给模板
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-zinc-600">
            不是玩具脚手架，而是一套能直接承载真实业务的全栈工程基座。
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 md:grid-cols-3">
          {/* 大 cell：分层架构 */}
          <Reveal className="md:col-span-2" delay={60}>
            <div className="group relative h-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-white to-zinc-50 p-6 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-orange-500/10 text-orange-700">
                  <Layers className="size-4.5" />
                </span>
                <h3 className="text-lg font-semibold text-zinc-950">分层架构，依赖方向不可逆</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                薄边界 + 业务核心：Hono 只做校验与转发，业务下沉 apps/server 模块层，能力复用 @repo/kits，单向依赖、职责清晰、可测试。
              </p>
              <ArchitectureDiagram />
            </div>
          </Reveal>

          {/* 小 cell：契约先行 */}
          <Reveal delay={120}>
            <div className="group relative h-full overflow-hidden rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-orange-700">
                  <Braces className="size-4.5" />
                </span>
                <h3 className="text-base font-semibold text-zinc-950">契约先行</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                Zod Schema 定义一切，后端校验、数据库、前端共用同一份契约，字段永不失同步。
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
            <div className="group relative h-full overflow-hidden rounded-2xl border border-zinc-200 bg-gradient-to-br from-orange-50 to-white p-6 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-orange-500/10 text-orange-700">
                  <PackageOpen className="size-4.5" />
                </span>
                <h3 className="text-lg font-semibold text-zinc-950">开箱即用的业务模块</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-zinc-600">
                认证、用户、待办等完整模块示例，覆盖契约、实体、服务、路由、页面全链路，照着抄就能扩展新业务。
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {['认证鉴权', '用户体系', '待办事项', '字典枚举', '对象存储', '消息队列'].map((m) => (
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
    <div className="group relative h-full overflow-hidden rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40">
      <span className="flex size-9 items-center justify-center rounded-xl bg-zinc-100 text-orange-700">
        <Icon className="size-4.5" />
      </span>
      <h3 className="mt-4 text-base font-semibold text-zinc-950">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-zinc-600">{desc}</p>
    </div>
  )
}
