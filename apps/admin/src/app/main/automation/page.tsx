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

      {/* 环境变量：白卡 + mono 键值（克制的信息化展示） */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card shadow-xs">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 font-mono text-xs">
          <span className="text-muted-foreground">billy-cli env</span>
          <span className="text-muted-foreground">{envEntries.length} 项</span>
        </div>
        <div className="h-full overflow-auto p-4 font-mono text-xs leading-5">
          {envEntries.map(([key, value]) => (
            <div key={key} className="whitespace-pre">
              <span className="text-foreground">{key}</span>
              <span className="text-muted-foreground"> = </span>
              <span className="text-muted-foreground">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
