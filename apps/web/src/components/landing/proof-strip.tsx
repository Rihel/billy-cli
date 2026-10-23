import { Reveal } from './reveal'

const facts = [
  { k: '10', label: '内建 AI 工具', detail: '计划、子 agent、命令、联网、取页' },
  { k: '12', label: '业务模块', detail: '认证、用户、存储、监控、AI、会话' },
  { k: '23', label: 'Agent Skills', detail: '每条规范都指向仓库真实文件' },
  { k: '48', label: 'AI 界面组件', detail: '会话、消息、推理、工具、计划' },
]

/** 首屏下方的事实横带：只给数字与一句解释，不堆卡片 */
export function ProofStrip() {
  return (
    <section aria-label="能力概览" className="border-y border-border/70">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-2 divide-border/70 md:grid-cols-4 md:divide-x">
          {facts.map((fact, i) => (
            <Reveal key={fact.label} delay={i * 50}>
              <div className="px-0 py-8 md:px-8 md:first:pl-0 md:last:pr-0">
                <div className="font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                  {fact.k}
                </div>
                <div className="mt-2 text-sm text-foreground">{fact.label}</div>
                <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{fact.detail}</div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}
