export const dynamic = 'force-dynamic'

export default async function AutomationPage() {
  const envString = Object.entries(process.env).reduce((acc, [key, val]) => {
    return `${acc}\n${key}=${val}`
  }, '')
  return (
    <div className="w-full">
      <pre className="text-xs bg-slate-100 p-4 leading-snug w-full">
        {envString}
      </pre>
    </div>
  )
}
