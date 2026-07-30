export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="w-full max-w-2xl px-5 py-10 bg-white shadow">
        {children}
      </div>
    </div>
  )
}
