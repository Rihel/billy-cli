import { CheckCircle2, TerminalSquare } from 'lucide-react'
import { Reveal } from './reveal'

const steps = [
  { cmd: 'pnpm bootstrap', note: '一键初始化：环境检查 → 依赖服务 → .env → 安装 → 迁移 → 冒烟' },
  { cmd: 'pnpm dev:pkgs & pnpm dev:server & pnpm dev:web', note: '并行启动开发环境 · 前台 9840' },
  { cmd: 'pnpm dev:admin', note: '管理后台 9845 · 控制台 / 监控 / AI 会话 / 模型 / 工具 / 审计 / 连接器' },
]

const prerequisites = [
  'Node.js ≥ 26（推荐 26.13）',
  'pnpm ≥ 12（推荐 12.18）',
  'Docker（可选，仅本地依赖）',
]

/** 快速开始：一条 bootstrap 完成初始化 + 并行启动（深色终端对比块） */
export function QuickStart() {
  return (
    <section id="quickstart" className="scroll-mt-20 overflow-hidden border-t border-border/70 bg-muted">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8 lg:py-28">
        <Reveal>
          <h2 className="font-heading max-w-md text-3xl font-semibold tracking-tight text-foreground sm:text-4xl md:text-5xl">
            五分钟，跑起来
          </h2>
          <p className="mt-4 max-w-md text-base leading-relaxed text-muted-foreground">
            一条 <code className="font-mono text-sm text-foreground">pnpm bootstrap</code>{' '}
            完成全部初始化，再并行启动开发环境，前后端热更新同步开发。
          </p>

          <ul className="mt-8 space-y-4">
            {steps.map((step, i) => (
              <li key={step.cmd} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-brand/10 font-mono text-xs font-semibold text-brand">
                  {i + 1}
                </span>
                <div>
                  <code className="font-mono text-sm text-foreground">{step.cmd}</code>
                  <p className="mt-0.5 text-sm text-muted-foreground">{step.note}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-8 space-y-2">
            {prerequisites.map((item) => (
              <p key={item} className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="size-4 text-brand" />
                {item}
              </p>
            ))}
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-3xl bg-gradient-to-tl from-brand/10 via-transparent to-transparent blur-2xl"
            />
            <div className="relative overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-b from-white to-brand/10 shadow-xl shadow-brand/10 ring-1 ring-brand/20">
              <div className="flex items-center gap-2 border-b border-brand/20 bg-brand/10 px-4 py-3">
                <span className="size-3 rounded-full bg-destructive/80" />
                <span className="size-3 rounded-full bg-warning/80" />
                <span className="size-3 rounded-full bg-success/80" />
                <span className="ml-2 font-mono text-xs text-muted-foreground">快速开始</span>
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                  <TerminalSquare className="size-3" />
                  zsh
                </span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
                <div>
                  <span className="select-none text-muted-foreground">$ </span>
                  <span className="text-success"># ① 一键初始化（交互确认，-y 全默认）</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">$ </span>
                  <span className="text-foreground">pnpm bootstrap</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">  </span>
                  <span className="text-muted-foreground">[1/6] 环境检查 ✓</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">  </span>
                  <span className="text-muted-foreground">[2/6] Docker 依赖服务 ✓</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">  </span>
                  <span className="text-muted-foreground">[3/6] 环境变量文件 ✓</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">  </span>
                  <span className="text-muted-foreground">[4/6] 依赖安装 ✓</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">  </span>
                  <span className="text-muted-foreground">[5/6] 数据库迁移与种子 ✓</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">  </span>
                  <span className="text-muted-foreground">[6/6] 服务冒烟验证 ✓</span>
                </div>
                <div className="mt-1">
                  <span className="select-none text-muted-foreground">$ </span>
                  <span className="text-success"># ② 并行启动开发环境</span>
                </div>
                <div>
                  <span className="select-none text-muted-foreground">$ </span>
                  <span className="text-foreground">pnpm dev:pkgs &amp; pnpm dev:server &amp; pnpm dev:web</span>
                </div>
                <div className="mt-1">
                  <span className="select-none text-muted-foreground">$ </span>
                  <span className="text-success">➜</span>{' '}
                  <span className="text-foreground">ready</span>{' '}
                  <span className="text-muted-foreground">· http://localhost:9840</span>
                  <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-brand" />
                </div>
              </pre>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
