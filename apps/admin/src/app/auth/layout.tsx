export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background lg:flex-row">
      {/* 左：品牌叙事栏（lg 以上显示，浅色编辑感 / dark 深蓝氛围） */}
      <div className="relative hidden flex-col justify-between overflow-hidden bg-surface-1 p-10 lg:flex lg:w-[44%] xl:w-[40%]">
        <div className="relative z-10 flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-md bg-brand text-white shadow-[0_2px_8px_-2px_rgb(79_70_229/0.55)]">
            <span className="font-mono text-sm font-bold">›</span>
          </span>
          <span className="font-heading text-lg font-semibold tracking-tight">
            Billy Cli
          </span>
        </div>
        <div className="relative z-10 max-w-sm">
          <p className="text-xs font-medium tracking-[0.2em] text-muted-foreground uppercase">
            Full-stack template
          </p>
          <p className="mt-4 font-heading text-3xl leading-tight font-semibold tracking-tight xl:text-4xl">
            一套模板
            <br />
            全栈直达
          </p>
          <p className="mt-5 text-sm leading-relaxed text-muted-foreground">
            NestJS 12 + Next.js 16 双前端，数据结构先行、AI 原生工程规范，从脚手架到生产一步到位。
          </p>
        </div>
        <div className="relative z-10 rounded-lg bg-card/80 px-3 py-3 shadow-[0_1px_2px_rgb(23_23_32/0.04)] backdrop-blur">
          <div className="flex items-center gap-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
            <span className="size-1.5 rounded-full bg-success" />
            admin console · running
          </div>
        </div>
      </div>

      {/* 右：表单区（玻璃卡悬浮） */}
      <div className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-[0_1px_2px_rgb(23_23_32/0.04),0_12px_32px_-12px_rgb(23_23_32/0.12)] sm:p-8">
          {/* 移动端品牌（lg 以下） */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="grid size-8 place-items-center rounded-md bg-brand text-white">
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
