import { CheckCircle2, TerminalSquare } from 'lucide-react'
import { Reveal } from './reveal'

const steps = [
  { cmd: 'pnpm bootstrap', note: '一键初始化：环境检查 → 依赖服务 → .env → 安装 → 迁移 → 冒烟' },
  { cmd: 'pnpm dev:pkgs & pnpm dev:server & pnpm dev:web', note: '并行启动开发环境 · 前台 9840' },
]

const prerequisites = [
  'Node.js ≥ 20（推荐 24）',
  'pnpm ≥ 11',
  'Docker（可选，仅本地依赖）',
]

/** 快速开始：一条 bootstrap 完成初始化 + 并行启动（深色终端对比块） */
export function QuickStart() {
  return (
    <section id="quickstart" className="scroll-mt-20 overflow-hidden border-t border-zinc-200/70 bg-zinc-50">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2 lg:px-8 lg:py-28">
        <Reveal>
          <h2 className="max-w-md text-3xl font-semibold tracking-tight text-zinc-950 sm:text-4xl">
            五分钟，跑起来
          </h2>
          <p className="mt-4 max-w-md text-base leading-relaxed text-zinc-600">
            一条 <code className="font-mono text-sm text-zinc-900">pnpm bootstrap</code>{' '}
            完成全部初始化，再并行启动开发环境，前后端热更新同步开发。
          </p>

          <ul className="mt-8 space-y-4">
            {steps.map((step, i) => (
              <li key={step.cmd} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-orange-500/10 font-mono text-xs font-semibold text-orange-700">
                  {i + 1}
                </span>
                <div>
                  <code className="font-mono text-sm text-zinc-900">{step.cmd}</code>
                  <p className="mt-0.5 text-sm text-zinc-500">{step.note}</p>
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-8 space-y-2">
            {prerequisites.map((item) => (
              <p key={item} className="flex items-center gap-2 text-sm text-zinc-600">
                <CheckCircle2 className="size-4 text-orange-600" />
                {item}
              </p>
            ))}
          </div>
        </Reveal>

        <Reveal delay={100}>
          <div className="relative">
            <div
              aria-hidden
              className="absolute -inset-6 rounded-3xl bg-gradient-to-tl from-orange-500/10 via-transparent to-transparent blur-2xl"
            />
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-zinc-900/25">
              <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                <span className="size-3 rounded-full bg-red-400/80" />
                <span className="size-3 rounded-full bg-amber-400/80" />
                <span className="size-3 rounded-full bg-emerald-400/80" />
                <span className="ml-2 font-mono text-xs text-zinc-500">快速开始</span>
                <span className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-mono text-[10px] text-zinc-500">
                  <TerminalSquare className="size-3" />
                  zsh
                </span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-7">
                <div>
                  <span className="select-none text-zinc-700">$ </span>
                  <span className="text-emerald-400"># ① 一键初始化（交互确认，-y 全默认）</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">$ </span>
                  <span className="text-zinc-100">pnpm bootstrap</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">  </span>
                  <span className="text-zinc-500">[1/6] 环境检查 ✓</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">  </span>
                  <span className="text-zinc-500">[2/6] Docker 依赖服务 ✓</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">  </span>
                  <span className="text-zinc-500">[3/6] 环境变量文件 ✓</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">  </span>
                  <span className="text-zinc-500">[4/6] 依赖安装 ✓</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">  </span>
                  <span className="text-zinc-500">[5/6] 数据库迁移与种子 ✓</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">  </span>
                  <span className="text-zinc-500">[6/6] 服务冒烟验证 ✓</span>
                </div>
                <div className="mt-1">
                  <span className="select-none text-zinc-700">$ </span>
                  <span className="text-emerald-400"># ② 并行启动开发环境</span>
                </div>
                <div>
                  <span className="select-none text-zinc-700">$ </span>
                  <span className="text-zinc-100">pnpm dev:pkgs &amp; pnpm dev:server &amp; pnpm dev:web</span>
                </div>
                <div className="mt-1 text-zinc-600">
                  <span className="select-none text-zinc-700">$ </span>
                  <span className="text-zinc-400">➜</span>{' '}
                  <span className="text-zinc-200">ready</span>{' '}
                  <span className="text-zinc-500">· http://localhost:9840</span>
                  <span className="ml-1 inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-orange-400" />
                </div>
              </pre>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
