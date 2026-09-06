import Link from 'next/link'
import { ArrowRight, LogIn } from 'lucide-react'
import { Button } from '@repo/ui'
import { Pages } from '@/lib/constants'
import { Reveal } from './reveal'

/** 收尾 CTA：居中大标题 + 双按钮 */
export function CtaSection() {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-64 bg-[radial-gradient(ellipse_60%_100%_at_50%_100%,rgb(59_130_246/0.1),transparent)]"
      />
      <div className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-950 sm:text-5xl">
            现在就开始你的全栈之旅
          </h2>
          <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-zinc-600">
            创建账号，体验完整的认证、用户与业务模块，或直接进入管理后台一览全貌。
          </p>
          <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
            <Button
              render={<Link href={Pages.register} />}
              size="lg"
              className="bg-zinc-950 text-white shadow-lg shadow-zinc-950/20 hover:bg-zinc-800"
            >
              创建账号
              <ArrowRight data-icon="inline-end" />
            </Button>
            <Button
              render={<Link href={Pages.login} />}
              size="lg"
              variant="outline"
              className="border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900"
            >
              <LogIn data-icon="inline-start" />
              登录
            </Button>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
