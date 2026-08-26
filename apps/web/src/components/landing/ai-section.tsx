import { Bot, CheckCircle2, Wand2, ShieldCheck, GitBranch } from 'lucide-react'
import { Reveal } from './reveal'

const chatMessages = [
  {
    role: 'dev' as const,
    text: '帮我新增一个「商品」业务模块',
  },
  {
    role: 'ai' as const,
    text: '已加载 develop-business-module 技能，按「契约 → 数据 → 业务 → 接口 → SDK → 页面」全链路推进。',
  },
  {
    role: 'ai' as const,
    text: '完成：ProductSchema 已定义、实体与迁移已生成、Service 已注册、路由已挂载、后台页面已登记菜单。',
  },
]

const checks = [
  'ProductSchema 已定义（@repo/shared）',
  'ProductEntity + 迁移已生成（@repo/db）',
  'ProductService 已注册（runtime.ts）',
  '路由已挂载 + SDK 已补全类型化方法',
  '后台商品页已登记菜单',
]

const skillGroups = [
  {
    label: '必读基础',
    items: ['billy-dev-foundation'],
    highlight: true,
  },
  {
    label: '全链路开发',
    items: [
      'define-data-structure',
      'define-dict-enum',
      'develop-business-module',
      'develop-frontend-page',
      'implement-auth',
      'object-storage',
    ],
  },
  {
    label: '基础设施与质量',
    items: ['queue', 'scheduler', 'state-machine', 'write-tests', 'git-workflow'],
  },
]

const points = [
  {
    icon: Wand2,
    title: '规范即技能',
    desc: '分层架构、命名、错误体系全部沉淀为 skill，AI 开工先加载必读规范。',
  },
  {
    icon: ShieldCheck,
    title: '全链路覆盖',
    desc: '从建表、契约到接口、页面、测试、提交，每一步都有对应 skill 兜底。',
  },
  {
    icon: GitBranch,
    title: '契约先行 + 全类型',
    desc: 'Zod 契约与类型化 SDK 让 AI 生成的代码天然对齐工程标准。',
  },
]

/** AI 原生能力：Agent Skills 驱动的开发体验 */
export function AiSection() {
  return (
    <section id="ai" className="relative scroll-mt-20 overflow-hidden border-t border-zinc-200/70 bg-zinc-50">
      <div
        aria-hidden
        className="absolute -top-40 left-1/4 h-96 w-150 -translate-x-1/2 rounded-full bg-orange-500/[0.08] blur-3xl motion-safe:animate-[glow_12s_ease-in-out_infinite]"
      />
      <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal>
          <p className="text-xs font-medium uppercase tracking-widest text-orange-600">
            AI 原生
          </p>
          <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
            让 AI 按你的规范写代码
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-zinc-600">
            工程内置 14 个 Agent Skills，把架构铁律、代码约定与全链路流程变成 AI
            可执行的规范，AI 写的代码也能符合你的工程标准。
          </p>
        </Reveal>

        <div className="mt-12 grid gap-4 lg:grid-cols-5">
          {/* 左：AI 会话演示（浅色聊天气泡） */}
          <Reveal className="lg:col-span-3">
            <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl shadow-zinc-200/60">
              <div className="flex items-center gap-2 border-b border-zinc-200 bg-zinc-50/80 px-4 py-3">
                <span className="flex size-6 items-center justify-center rounded-md bg-orange-500/10 text-orange-700">
                  <Bot className="size-3.5" />
                </span>
                <span className="font-mono text-xs text-zinc-500">AI 编码会话</span>
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  已连接
                </span>
              </div>

              <div className="flex-1 space-y-4 p-5">
                {chatMessages.map((msg) => (
                  <div
                    key={msg.text}
                    className={`flex ${msg.role === 'dev' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                        msg.role === 'dev'
                          ? 'rounded-br-md border border-orange-200 bg-orange-500/10 text-orange-900'
                          : 'rounded-bl-md border border-zinc-200 bg-zinc-50 text-zinc-700'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))}

                <div className="mt-5 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-medium text-zinc-600">
                    <CheckCircle2 className="size-3.5 text-emerald-600" />
                    交付检查清单
                  </p>
                  <ul className="space-y-1.5">
                    {checks.map((check) => (
                      <li key={check} className="flex items-center gap-2 font-mono text-xs text-zinc-600">
                        <span className="text-emerald-600">✓</span>
                        {check}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </Reveal>

          {/* 右：skill 墙 + 价值点 */}
          <div className="flex flex-col gap-4 lg:col-span-2">
            {skillGroups.map((group, gi) => (
              <Reveal key={group.label} delay={gi * 60}>
                <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm shadow-zinc-200/50">
                  <p
                    className={`mb-3 text-xs font-medium ${
                      group.highlight ? 'text-orange-700' : 'text-zinc-500'
                    }`}
                  >
                    {group.label}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {group.items.map((skillName) => (
                      <code
                        key={skillName}
                        className={`rounded-lg border px-2.5 py-1 font-mono text-xs ${
                          group.highlight
                            ? 'border-orange-500/30 bg-orange-500/10 text-orange-700'
                            : 'border-zinc-200 bg-zinc-50 text-zinc-600'
                        }`}
                      >
                        {skillName}
                      </code>
                    ))}
                  </div>
                </div>
              </Reveal>
            ))}

            <Reveal delay={180}>
              <div className="grid gap-3">
                {points.map((point) => (
                  <div
                    key={point.title}
                    className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white px-4 py-3.5 shadow-sm shadow-zinc-200/50 transition-colors hover:border-orange-500/40"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-orange-700">
                      <point.icon className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-zinc-900">{point.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-600">{point.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
