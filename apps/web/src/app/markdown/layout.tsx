import type { Metadata } from 'next'
import { MarkdownNav } from './nav'

export const metadata: Metadata = {
  title: 'Markdown 文档渲染演示 - Billy CLI',
  description:
    '基于 @repo/ui Markdown 组件的多页面渲染测试：基础语法、GFM 扩展、代码高亮与完整文档场景。',
}

export default function MarkdownLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen bg-white text-zinc-900 selection:bg-indigo-200">
      <MarkdownNav />
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">{children}</main>
    </div>
  )
}
