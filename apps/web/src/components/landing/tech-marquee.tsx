'use client'

import Marquee from 'react-fast-marquee'

const techStack = [
  'TypeScript',
  'Hono',
  'InversifyJS',
  'Next.js 16',
  'TypeORM',
  'PostgreSQL',
  'Redis',
  'Zod',
  'Tailwind 4',
  'Base UI',
  'shadcn/ui',
  'TanStack',
  'Docker',
]

/**
 * 技术栈无限滚动条（react-fast-marquee：autoFill 无缝循环、悬停暂停）。
 * 两侧渐隐遮罩自绘；减速偏好下用 CSS 覆盖内部滚动动画。
 */
export function TechMarquee() {
  return (
    <section aria-label="技术栈" className="border-y border-zinc-200/70 bg-zinc-50 py-5">
      {/* 占位高度 min-h 防止 SSR 水合前后高度跳动（库在客户端测量宽度后才渲染内容） */}
      <div className="relative mx-auto min-h-[38px] max-w-7xl overflow-hidden px-4 sm:px-6 lg:px-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-24 bg-gradient-to-r from-zinc-50 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-24 bg-gradient-to-l from-zinc-50 to-transparent"
        />
        <Marquee
          speed={40}
          autoFill
          pauseOnHover
          gradient={false}
          className="motion-reduce:[&_.rfm-marquee]:!animate-none"
        >
          {techStack.map((name) => (
            <span
              key={name}
              className="mr-3 inline-flex shrink-0 items-center gap-2 rounded-full border border-zinc-200 bg-white px-4 py-1.5 font-mono text-sm text-zinc-600"
            >
              <span className="size-1.5 rounded-full bg-orange-500/70" />
              {name}
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  )
}
