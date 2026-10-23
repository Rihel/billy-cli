import { Reveal } from './reveal'

const trace = [
  { step: '请求进来', detail: 'requestId 写进 ALS，后续日志与指标都带它' },
  { step: '日志', detail: 'pino 一行 JSON：谁、做了什么、多久；开发环境美化输出' },
  { step: '指标', detail: 'QPS、耗时、错误率；Counter / Gauge / Histogram，窗口快照带环比' },
  { step: '告警', detail: '规则命中后按级别分流，走文件、邮件或飞书' },
  { step: 'AI 运行', detail: '轮次、工具调用、tokens、输入快照全落库，可回放' },
]

const capabilities = [
  {
    title: '五个监控页',
    detail: '状态 / 实时 / 指标 / 日志 / 规则，不用连服务器看日志',
    path: 'apps/admin/src/app/main/monitor',
  },
  {
    title: '探针分两种',
    detail: '/healthz 只看进程，/readyz 探依赖；滚动更新先摘流再退出',
    path: 'apps/server/src/modules/ops',
  },
  {
    title: '日志有上下文',
    detail: 'requestId、userId、adminId 自动带上，排障从一条日志串起整条链路',
    path: 'common/request-context',
  },
  {
    title: '指标有环比',
    detail: '窗口聚合后给快照，页面回答“现在多少、最近怎么走、在什么区间”',
    path: 'packages/kits/src/telemetry',
  },
  {
    title: 'AI 调用可审计',
    detail: '运行列表、运行详情、子 agent 的输入提示词、错误原文都在后台可查',
    path: 'apps/server/src/modules/ai/runtime',
  },
]

/** 卖点二：可观测性。左边一条请求的轨迹，右边能力清单。 */
export function Observability() {
  return (
    <section id="observability" className="scroll-mt-20 border-t border-border/70 bg-muted/60">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        <Reveal>
          <p className="font-mono text-xs font-medium tracking-[0.18em] text-brand uppercase">
            可观测性
          </p>
          <h2 className="font-heading mt-5 max-w-2xl text-4xl leading-[1.05] font-semibold tracking-tight text-foreground sm:text-5xl">
            出问题时，
            <br />
            不用登录服务器
          </h2>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground">
            一次请求从进来到落库，日志、指标、告警、AI 运行都有记录，后台五个页面直接看。
            埋在代码里的观测点不是摆设，是排障时的第一手证据。
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
          {/* 左：请求轨迹 */}
          <div>
            <p className="font-mono text-xs text-muted-foreground">一次请求的轨迹</p>
            <ol className="mt-6">
              {trace.map((item, i) => (
                <Reveal key={item.step} delay={i * 50}>
                  <li className="relative border-l border-border pb-8 pl-6 last:pb-0">
                    <span
                      aria-hidden
                      className="absolute -left-[3px] top-1.5 size-[5px] rounded-full bg-brand"
                    />
                    <p className="text-sm font-medium text-foreground">{item.step}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.detail}</p>
                  </li>
                </Reveal>
              ))}
            </ol>

            <Reveal delay={120}>
              <div className="mt-8 rounded-xl border border-border bg-card px-5 py-4">
                <p className="text-xs font-medium text-foreground">一句话的排障路径</p>
                <p className="mt-2 font-mono text-[11.5px] leading-6 text-muted-foreground">
                  requestId → 日志看是谁 → 指标看多慢 → 告警看有没有触发 → 运行详情看模型想干什么
                </p>
              </div>
            </Reveal>
          </div>

          {/* 右：能力清单 */}
          <div>
            {capabilities.map((cap, i) => (
              <Reveal key={cap.title} delay={i * 50}>
                <div className="border-t border-border py-6 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-base font-medium text-foreground">{cap.title}</h3>
                    <code className="font-mono text-[11px] text-muted-foreground">{cap.path}</code>
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{cap.detail}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
