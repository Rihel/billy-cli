import { Bot, CheckCircle2, Wand2, ShieldCheck, GitBranch, Target } from 'lucide-react'
import { Reveal } from './reveal'

const chatMessages = [
  {
    role: 'dev' as const,
    text: '帮我新增一个「商品」业务模块',
  },
  {
    role: 'ai' as const,
    text: '已加载 develop-business-module 技能，按「数据结构 → 建表 → 业务 → 接口 → SDK → 页面」全链路推进。',
  },
  {
    role: 'ai' as const,
    text: '完成：ProductSchema 已定义、实体与迁移已生成、Service 已注册、路由已挂载、后台页面已登记菜单。',
  },
]

const checks = [
  'ProductSchema 已定义（@repo/shared）',
  'ProductEntity + 迁移已生成（apps/server/src/database）',
  'ProductService 已注册（root.module.ts 组合根 + 业务模块 providers）',
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
      'database',
      'define-dict-enum',
      'develop-business-module',
      'develop-backend-api',
      'develop-frontend-page',
      'implement-auth',
      'object-storage',
    ],
  },
  {
    label: '基础设施与质量',
    items: [
      'concurrency',
      'kafka',
      'scheduler',
      'stream',
      'state-machine',
      'write-tests',
      'git-workflow',
      'manage-skills',
    ],
  },
]

const points = [
  {
    icon: Wand2,
    title: '规范即技能',
    desc: '分层架构、命名、错误体系全部写进 skill，AI 开工先读必读规范。',
  },
  {
    icon: ShieldCheck,
    title: '全链路覆盖',
    desc: '从数据结构、建表到接口、页面、测试、提交，每一步都有对应 skill 兜底。',
  },
  {
    icon: GitBranch,
    title: '数据结构先行 + 全类型',
    desc: '数据结构与类型化 SDK 让 AI 生成的代码天然符合工程标准。',
  },
  {
    icon: Target,
    title: '按需加载',
    desc: '17 个 skill 不是一次性全读，AI 按任务只加载相关 skill，裁剪上下文、省 Token。',
  },
]

/** AI 原生能力：Agent Skills 驱动的开发体验 */
export function AiSection() {
  return (
    <section id="ai" className="relative scroll-mt-20 overflow-hidden border-t border-border/70 bg-muted">
      <div
        aria-hidden
        className="absolute -top-40 left-1/4 h-96 w-150 -translate-x-1/2 rounded-full bg-brand/[0.08] blur-3xl motion-safe:animate-[glow_12s_ease-in-out_infinite]"
      />
      <div className="relative mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8 lg:py-28">
        <Reveal>
          <div className="flex items-center gap-3">
            <span className="h-px w-8 bg-brand" aria-hidden />
            <p className="font-mono text-xs font-medium tracking-[0.18em] text-brand uppercase">
              AI 原生
            </p>
          </div>
          <h2 className="font-heading mt-4 max-w-2xl text-3xl font-semibold tracking-tight text-foreground sm:text-4xl md:text-5xl">
            让 AI 按你的规范写代码
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
            工程内置 17 个 Agent Skills，把架构规范与完整流程变成 AI
            可执行的规范，AI 写的代码也能符合你的工程标准。
          </p>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* 左：AI 会话演示（浅色聊天气泡） */}
          <Reveal className="lg:col-span-3">
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card">
              <div className="flex items-center gap-2 border-b border-border bg-muted/80 px-4 py-3">
                <span className="flex size-6 items-center justify-center rounded-md bg-brand/10 text-brand">
                  <Bot className="size-3.5" />
                </span>
                <span className="font-mono text-xs text-muted-foreground">AI 编码会话</span>
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-success/20 bg-success/10 px-2 py-0.5 text-[10px] font-medium text-success">
                  <span className="size-1.5 rounded-full bg-success" />
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
                          ? 'rounded-br-md border border-brand/30 bg-brand/10 text-brand'
                          : 'rounded-bl-md border border-border bg-muted text-foreground'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </div>
                ))}

                <div className="mt-5 rounded-xl border border-border bg-muted p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <CheckCircle2 className="size-3.5 text-success" />
                    交付检查清单
                  </p>
                  <ul className="space-y-1.5">
                    {checks.map((check) => (
                      <li key={check} className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                        <span className="text-success">✓</span>
                        {check}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </Reveal>

          {/* 右：skill 规则示例 + skill 墙 + 价值点 */}
          <div className="flex flex-col gap-4 lg:col-span-2">
            <Reveal>
              <div className="rounded-2xl border border-brand/30 bg-brand/[0.06] p-5">
                <p className="text-xs font-medium text-brand">skill 里的硬性规则（示例）</p>
                <ul className="mt-3 space-y-1.5 font-mono text-xs leading-relaxed text-muted-foreground">
                  <li>· controller 只做校验与转发，业务逻辑在 service</li>
                  <li>· 错误继承 AppError，code 在 AppErrorCodes（3xxx 段）</li>
                  <li>· schema / dict / entity 字段一致并注册 index.ts</li>
                </ul>
              </div>
            </Reveal>
            {skillGroups.map((group, gi) => (
              <Reveal key={group.label} delay={gi * 60}>
                <div className="rounded-xl border border-border bg-card p-5">
                  <p
                    className={`mb-3 text-xs font-medium ${
                      group.highlight ? 'text-brand' : 'text-muted-foreground'
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
                            ? 'border-brand/30 bg-brand/10 text-brand'
                            : 'border-border bg-muted text-muted-foreground'
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
              <div className="grid grid-cols-1 gap-3">
                {points.map((point) => (
                  <div
                    key={point.title}
                    className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 transition-all hover:-translate-y-0.5 hover:border-brand/60 hover:shadow-sm"
                  >
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-brand">
                      <point.icon className="size-4" />
                    </span>
                    <div>
                      <p className="text-sm font-medium text-foreground">{point.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{point.desc}</p>
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
