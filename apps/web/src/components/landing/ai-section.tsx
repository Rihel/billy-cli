import Link from 'next/link'
import { ArrowRight, MessagesSquare, Wrench, Rocket, Plug } from 'lucide-react'
import { Reveal } from './reveal'

const stages = [
  {
    no: '01',
    icon: MessagesSquare,
    title: '能对话',
    desc: '会话、运行、时间线三张表。文本、推理、工具调用、步骤、来源全都流式推过来；刷新或断线从上次位置续传；图片和 PDF 直接发给模型。',
    chips: ['chat/stream', 'chat/resume', 'run/stream', '多模态附件'],
  },
  {
    no: '02',
    icon: Wrench,
    title: '能干活',
    desc: '计划四件套、动态子 agent、命令执行、联网三件套、大结果取页、技能库与文件工具，26 个工具开箱可用。每次调用都过同一个网关，开关、作用域、限额、审计都在那里。',
    chips: ['plan-*', 'run-sub-agent', 'bash', 'web-search'],
  },
  {
    no: '03',
    icon: Rocket,
    title: '能上线',
    desc: '服务重启后在跑的会话继续；上下文到模型窗口 70% 自动压缩；多用户会话隔离；tokens 与步数逐轮入库；运行详情能回看输入快照与错误原文。',
    chips: ['崩溃恢复', '上下文压缩', 'ai-usage', '审计'],
  },
  {
    no: '04',
    icon: Plug,
    title: '能连外部',
    desc: '数据库、Redis、飞书 CLI 在后台加一条连接器，就产出一组模型能调的工具。地址、凭证、开关、限额、审计都挂在连接器上，接一个新系统不用改代码、不用发版。',
    chips: ['postgres / mysql', 'redis', 'lark-cli', 'ai-connector'],
  },
]

const facts = [
  ['conversations · runs · timelines', '会话、运行、时间线三张表，全部入库'],
  ['26 个内建工具', '计划、子 agent、命令、联网、取页、技能库、文件'],
  ['4 类连接器', '数据库 / Redis / 飞书 CLI，一行数据接一个外部系统'],
  ['48 个 ai-elements', '会话、消息、推理、工具、计划'],
]

/**
 * 卖点一：开箱即用的 AI 应用开发能力。
 * 布局：左栏 sticky 宣言，右栏三段能力（细线分隔，不用卡片）+ 一个真实写法示例。
 */
export function AiSection() {
  return (
    <section id="ai" className="scroll-mt-20 border-t border-border/70">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-[0.85fr_1.15fr] lg:gap-20">
          {/* 左栏：宣言 */}
          <div className="lg:sticky lg:top-24 lg:self-start">
            <Reveal>
              <p className="font-mono text-xs font-medium tracking-[0.18em] text-brand uppercase">
                AI 应用开发
              </p>
              <h2 className="font-heading mt-5 text-4xl leading-[1.05] font-semibold tracking-tight text-foreground sm:text-5xl">
                从能对话，
                <br />
                到能上线
              </h2>
              <p className="mt-6 max-w-sm text-base leading-relaxed text-muted-foreground">
                不是接一个模型
                API、画一个聊天框就结束。会话、流式、工具、连接器、权限、恢复、用量、审计
                都在仓库里跑通，你要改的是提示词、工具和业务。
              </p>

              <div className="mt-8 space-y-3 border-t border-border pt-6">
                {facts.map(([key, note]) => (
                  <div key={key}>
                    <p className="font-mono text-xs text-foreground">{key}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>
                  </div>
                ))}
              </div>

              <Link
                href="#quickstart"
                className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-brand hover:text-brand/80"
              >
                看怎么跑起来 <ArrowRight className="size-3.5" />
              </Link>
            </Reveal>
          </div>

          {/* 右栏：三段能力 + 写法 */}
          <div>
            {stages.map((stage, i) => (
              <Reveal key={stage.title} delay={i * 60}>
                <div className="grid grid-cols-[2.5rem_1fr] gap-4 border-t border-border py-8 first:border-t-0 first:pt-0 md:gap-8">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand">
                    <stage.icon className="size-5" />
                  </span>
                  <div>
                    <div className="flex items-baseline gap-3">
                      <span className="font-mono text-xs text-muted-foreground">{stage.no}</span>
                      <h3 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
                        {stage.title}
                      </h3>
                    </div>
                    <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
                      {stage.desc}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {stage.chips.map((chip) => (
                        <code
                          key={chip}
                          className="rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                        >
                          {chip}
                        </code>
                      ))}
                    </div>
                  </div>
                </div>
              </Reveal>
            ))}

            <Reveal delay={120}>
              <div className="mt-8 overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex items-center justify-between border-b border-border px-5 py-3">
                  <p className="text-xs font-medium text-foreground">加一个工具，只要一个方法</p>
                  <span className="font-mono text-[11px] text-muted-foreground">
                    apps/server/src/modules/ai/tools
                  </span>
                </div>
                <pre className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-6 text-muted-foreground">
                  <code>{`@ToolGroup({ category: 'business' })
export class OrderTools {
  @ToolDecl({
    key: 'order-lookup',
    title: '查订单',
    description: '按订单号查状态与金额，只读。',
    params: z.object({ id: z.string() }),
    config: z.object({ timeoutMs: z.number().default(5000) }),
  })
  async lookup(input, ctx) {
    return this.orders.byId(input.id)
  }
}`}</code>
                </pre>
                <p className="border-t border-border px-5 py-3 text-xs leading-relaxed text-muted-foreground">
                  写进 <code className="font-mono text-foreground">AGENT_TOOL_GROUPS</code>{' '}
                  就注册完成： 参数自动生成给模型的 schema，开关、限额、审计、分页由网关统一处理。
                  不想写代码也可以走连接器：后台加一行数据，同样产出受管工具。
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  )
}
