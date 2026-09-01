export const dynamic = 'force-dynamic'

export default async function AutomationPage() {
  const envString = Object.entries(process.env).reduce((acc, [key, val]) => {
    return `${acc}\n${key}=${val}`
  }, '')
  return (
    <div className="w-full">
      <pre className="w-full rounded-lg border border-border bg-background p-4 text-xs leading-snug shadow-xs">
        {envString}
      </pre>
    </div>
  )
}
