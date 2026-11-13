import { Badge, Button, Input, Label, SegmentedControl } from '@repo/ui'
import { Reveal } from './reveal'

const palette = [
  { name: 'brand', className: 'bg-brand', note: '品牌色，焦点环与图表首色都由它派生' },
  { name: 'success', className: 'bg-success', note: '状态色，永远和文案成对出现' },
  { name: 'warning', className: 'bg-warning', note: '状态色，不降级成装饰' },
  { name: 'destructive', className: 'bg-destructive', note: '错误与危险操作' },
]

const surfaces = [
  { name: '页面底', className: 'bg-background' },
  { name: '卡片', className: 'bg-card' },
  { name: '卡内磁贴', className: 'bg-muted' },
  { name: '控件底', className: 'bg-surface-3' },
]

/**
 * 卖点三：高颜值。
 * 布局：规格表（hairline 网格），左边色板、中间组件、右边字体与圆角，全部用真实组件渲染。
 */
export function DesignShowcase() {
  return (
    <section id="design" className="scroll-mt-20 border-t border-border/70">
      <div className="mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8 lg:py-32">
        <Reveal>
          <h2 className="font-heading max-w-3xl text-4xl leading-[1.05] font-semibold tracking-tight text-foreground sm:text-5xl">
            好看不是修出来的，
            <br />
            是定出来的
          </h2>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
            颜色、字体、圆角、面层全在 <code className="font-mono text-foreground">
              @repo/ui
            </code>{' '}
            里定义一次，
            前台与后台共用；换品牌色只改一个变量。下面这些不是截图，是组件库在页面里的真实渲染。
          </p>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-3">
          {/* 色板 */}
          <Reveal className="bg-card">
            <div className="h-full p-6">
              <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                Color
              </p>
              <div className="mt-5 space-y-4">
                {palette.map((color) => (
                  <div key={color.name}>
                    <div className="flex items-center gap-3">
                      <span className={`h-9 w-14 rounded-md ${color.className}`} aria-hidden />
                      <div>
                        <p className="font-mono text-xs text-foreground">{color.name}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{color.note}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 flex gap-1.5">
                {surfaces.map((surface) => (
                  <span
                    key={surface.name}
                    title={surface.name}
                    className={`h-8 flex-1 rounded-md border border-border ${surface.className}`}
                  />
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                面层靠明度差分层次，不画边框也不叠投影
              </p>
            </div>
          </Reveal>

          {/* 组件 */}
          <Reveal className="bg-card" delay={60}>
            <div className="h-full p-6">
              <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                Components
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button size="sm">主按钮</Button>
                <Button size="sm" variant="outline">
                  次按钮
                </Button>
                <Button size="sm" variant="ghost">
                  幽灵
                </Button>
              </div>

              <div className="mt-6 flex flex-wrap gap-2">
                <Badge className="border-success/20 bg-success/10 text-success">运行中</Badge>
                <Badge className="border-warning/20 bg-warning/10 text-warning">排队</Badge>
                <Badge className="border-destructive/20 bg-destructive/10 text-destructive">
                  失败
                </Badge>
                <Badge variant="outline">草稿</Badge>
              </div>

              <div className="mt-6 space-y-2">
                <Label htmlFor="spec-email" className="text-xs">
                  邮箱
                </Label>
                <Input id="spec-email" placeholder="you@example.com" className="h-9 text-sm" />
              </div>

              <div className="mt-6">
                <SegmentedControl
                  value="7"
                  options={[
                    { label: '7 天', value: '7' },
                    { label: '30 天', value: '30' },
                  ]}
                />
              </div>
            </div>
          </Reveal>

          {/* 字体与圆角 */}
          <Reveal className="bg-card" delay={120}>
            <div className="h-full p-6">
              <p className="font-mono text-[11px] tracking-wide text-muted-foreground uppercase">
                Type & Shape
              </p>
              <div className="mt-5 space-y-4">
                <div>
                  <p className="font-heading text-2xl font-semibold tracking-tight text-foreground">
                    标题 Display
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    font-heading / tracking-tight
                  </p>
                </div>
                <div>
                  <p className="text-base text-foreground">
                    正文用系统无衬线，中文回退链路已接好。
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    text-base / leading-relaxed
                  </p>
                </div>
                <div>
                  <p className="font-mono text-sm text-foreground">pnpm check:ui</p>
                  <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                    Geist Mono / 等宽数字
                  </p>
                </div>
              </div>

              <div className="mt-6 flex items-center gap-2">
                <span className="flex h-10 flex-1 items-center justify-center rounded-md border border-border text-[11px] text-muted-foreground">
                  6
                </span>
                <span className="flex h-10 flex-1 items-center justify-center rounded-lg border border-border text-[11px] text-muted-foreground">
                  8
                </span>
                <span className="flex h-10 flex-1 items-center justify-center rounded-xl border border-border text-[11px] text-muted-foreground">
                  12
                </span>
                <span className="flex h-10 flex-1 items-center justify-center rounded-full border border-border text-[11px] text-muted-foreground">
                  全圆
                </span>
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">
                圆角有规则：控件 8、卡片 12、按钮全圆，不随手加
              </p>
            </div>
          </Reveal>
        </div>

        <Reveal delay={80}>
          <div className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 text-sm text-muted-foreground">
            <span>
              <span className="text-foreground">60+</span> 个基础组件
            </span>
            <span>
              <span className="text-foreground">48</span> 个 AI 界面组件
            </span>
            <span>
              <span className="text-foreground">一套</span> 设计 token，两个前端共用
            </span>
            <span>
              <span className="text-foreground">check:ui</span> 守住硬编码颜色
            </span>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
