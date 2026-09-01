export const dynamic = 'force-dynamic'

export default async function AutomationPage() {
  // 过滤含敏感词的变量，避免在前端直接暴露密钥（保留常规配置便于排查）
  const SENSITIVE = /(secret|token|key|password|passwd|credential)/i
  const envEntries = Object.entries(process.env).filter(
    ([key]) => !SENSITIVE.test(key),
  )

  return (
    <div className="flex h-full flex-col gap-4 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">自动化</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          服务端环境变量预览（已过滤密钥类变量）
        </p>
      </div>

      {/* 深色终端块：与前台代码块语言一致（mono + zinc-950 底 + 语法高亮） */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-lg shadow-zinc-900/20">
        <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2.5 font-mono text-xs">
          <span className="size-2.5 rounded-full bg-red-400/80" />
          <span className="size-2.5 rounded-full bg-amber-400/80" />
          <span className="size-2.5 rounded-full bg-emerald-400/80" />
          <span className="ml-2 text-zinc-500">billy-cli · env</span>
        </div>
        <pre className="h-full overflow-auto p-4 font-mono text-xs leading-5">
          {envEntries.map(([key, value], index) => (
            <div key={key} className="whitespace-pre">
              <span className="select-none text-zinc-700">
                {String(index + 1).padStart(2, '0')}{' '}
              </span>
              <span className="text-zinc-300">{key}</span>
              <span className="text-zinc-500"> = </span>
              <span className="text-zinc-400">{value}</span>
            </div>
          ))}
        </pre>
      </div>
    </div>
  )
}
