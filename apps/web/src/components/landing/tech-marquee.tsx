'use client'

import Marquee from 'react-fast-marquee'

const techStack = [
  'TypeScript',
  'NestJS',
  'Express 5',
  'Next.js 16',
  'Mastra',
  'AI SDK 6',
  'TypeORM',
  'PostgreSQL',
  'Redis',
  'Kafka',
  'Zod',
  'Tailwind 4',
  'Base UI',
  'shadcn/ui',
  'TanStack',
  'Docker',
  'Kubernetes',
]

/**
 * 技术栈无限滚动带（react-fast-marquee：autoFill 无缝循环、悬停暂停）。
 * 通栏铺满（不套 max-w 容器）：整条从视口左侧滚到右侧，两侧用 CSS mask 渐隐；
 * 遮罩不再盖「背景色 → 透明」的色块 —— 色块必须知道背后是什么颜色，底色一变就露馅。
 * 减速偏好下用 CSS 覆盖内部滚动动画。
 */
export function TechMarquee() {
  return (
    <section aria-label="技术栈" className="py-5">
      <div className="relative min-h-[36px] overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_14%,black_86%,transparent)]">
        {/*
          两侧用 CSS mask 渐隐，而不是盖两块「背景色 → 透明」的遮罩：
          遮罩必须知道背后是什么颜色，底色一变就露出色块；mask 直接让文字渐隐，背景永远透出页面本身。
        */}
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
              className="mr-8 inline-flex shrink-0 items-center gap-4 font-mono text-sm text-muted-foreground"
            >
              {name}
              <span className="size-1 rounded-full bg-muted-foreground/40" aria-hidden />
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  )
}
