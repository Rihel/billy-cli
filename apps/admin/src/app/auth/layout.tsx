export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      {/* 左：品牌叙事栏（lg 以上显示，浅色编辑感 / dark 深蓝氛围） */}
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-border bg-gradient-to-b from-indigo-50/70 via-background to-background p-10 lg:flex lg:w-[44%] xl:w-[40%] dark:from-indigo-950/40 dark:via-background dark:to-background">
        <div
          aria-hidden
          className="pointer-events-none absolute -top-24 -left-20 size-80 rounded-full bg-indigo-500/10 blur-3xl dark:bg-indigo-500/20"
        />
        <div className="relative z-10 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-600/25">
            <span className="font-mono text-sm font-bold">›</span>
          </span>
          <span className="font-heading text-lg font-semibold tracking-tight">
            Billy Cli
          </span>
        </div>
        <div className="relative z-10 max-w-sm">
          <p className="text-xs font-medium tracking-[0.2em] text-indigo-600 uppercase dark:text-indigo-400">
            Full-stack template
          </p>
          <p className="mt-4 font-heading text-3xl leading-tight font-semibold tracking-tight xl:text-4xl">
            一套模板
            <br />
            全栈直达
          </p>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            Hono + Next.js 16 双前端，数据结构先行、AI 原生工程规范，从脚手架到生产一步到位。
          </p>
        </div>
        <div className="relative z-10 border-t border-border pt-5">
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
            <span className="size-1.5 rounded-full bg-emerald-500" />
            admin console · running
          </div>
        </div>
      </div>

      {/* 右：表单区（玻璃卡悬浮） */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm rounded-2xl border border-border/70 bg-card/80 p-6 shadow-[0_2px_16px_rgba(0,0,0,0.04)] backdrop-blur-sm sm:p-8">
          {/* 移动端品牌（lg 以下） */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid size-8 place-items-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm shadow-indigo-600/25">
              <span className="font-mono text-sm font-bold">›</span>
            </span>
            <span className="font-heading text-lg font-semibold tracking-tight">
              Billy Cli
            </span>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
