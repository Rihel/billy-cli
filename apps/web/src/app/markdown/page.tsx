import type { Metadata } from 'next'
import Link from 'next/link'
import { Markdown } from '@repo/ui'

export const metadata: Metadata = {
  title: 'Markdown 演示总览 - Billy CLI',
}

const intro = `# Markdown 文档渲染组件

\`Markdown\` 是 \`@repo/ui\` 提供的文档渲染组件，基于 react-markdown 构建：

- 支持 GFM 扩展（表格、任务列表、删除线、自动链接）
- 代码块经 highlight.js 语法高亮，明暗主题自动适配
- 每个元素都有内置渲染样式，可按元素覆盖（\`components\` prop）
- 默认不渲染原始 HTML，防止 XSS

以下四个页面分别覆盖不同的渲染场景，用于验证组件的各个元素样式。`

const demos = [
  {
    href: '/markdown/basic',
    title: '基础语法',
    description: '标题层级、段落、文本样式、列表、引用、分割线、链接与图片。',
  },
  {
    href: '/markdown/gfm',
    title: 'GFM 扩展',
    description: '表格（含长表格横向滚动与对齐）、任务列表、删除线与自动链接。',
  },
  {
    href: '/markdown/code',
    title: '代码高亮',
    description: '多语言代码块语法高亮、行内代码、无语言标注代码块的兜底样式。',
  },
  {
    href: '/markdown/article',
    title: '完整文档',
    description: '模拟一篇真实 README 的长文场景，混合各类元素综合验证。',
  },
]

export default function MarkdownOverviewPage() {
  return (
    <div className="space-y-10">
      <Markdown content={intro} />
      <div className="grid gap-4 sm:grid-cols-2">
        {demos.map((demo) => (
          <Link
            key={demo.href}
            href={demo.href}
            className="group rounded-xl border border-zinc-200 bg-white p-5 transition-all hover:border-zinc-300 hover:shadow-md hover:shadow-zinc-200/60"
          >
            <h2 className="text-base font-semibold tracking-tight text-zinc-900 group-hover:text-orange-600">
              {demo.title}
              <span aria-hidden="true" className="ml-1 text-zinc-300 transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">
              {demo.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  )
}
