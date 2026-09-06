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
 * 技术栈无限滚动带（react-fast-marquee：autoFill 无缝循环、悬停暂停）。
 * 纯文字 + mono 分隔点，无 pill 边框；两侧渐隐遮罩自绘；
 * 减速偏好下用 CSS 覆盖内部滚动动画。
 */
export function TechMarquee() {
  return (
    <section aria-label="技术栈" className="border-b border-zinc-200/70 py-4">
      <div className="relative mx-auto min-h-[36px] max-w-7xl overflow-hidden px-4 sm:px-6 lg:px-8">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 z-10 w-20 bg-gradient-to-r from-white to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 z-10 w-20 bg-gradient-to-l from-white to-transparent"
        />
        <Marquee
          speed={45}
          autoFill
          pauseOnHover
          gradient={false}
          className="motion-reduce:[&_.rfm-marquee]:!animate-none"
        >
          {techStack.map((name) => (
            <span
              key={name}
              className="mr-10 inline-flex shrink-0 items-center gap-10 font-mono text-sm text-zinc-400"
            >
              {name}
              <span className="size-1 rounded-full bg-zinc-300" aria-hidden />
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  )
}
