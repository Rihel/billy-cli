export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* 品牌光晕：与前台 landing 的橙色光晕呼应，克制的氛围而非装饰条 */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[36rem] -translate-x-1/2 rounded-full bg-orange-500/10 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -right-24 size-80 rounded-full bg-orange-500/10 blur-3xl"
      />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg shadow-orange-900/5 sm:p-8">
        {children}
      </div>
    </div>
  )
}
