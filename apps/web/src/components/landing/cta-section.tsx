import Link from 'next/link'
import { ArrowRight, LogIn } from 'lucide-react'
import { Button } from '@repo/ui'
import { Pages } from '@/lib/constants'
import { Reveal } from './reveal'
import type { AuthUserModel } from '@repo/shared'

export type CtaSectionProps = {
  /** 服务端探测到的登录用户：已登录时隐藏「创建账号 / 登录」入口 */
  user: AuthUserModel | null
  /** 用户体系开关：关闭时不渲染任何账号入口（与 Header 同一约定） */
  authEnabled: boolean
}

/** 收尾 CTA：居中大标题 + 双按钮（已登录或用户体系关闭时不再展示账号入口） */
export function CtaSection({ user, authEnabled }: CtaSectionProps) {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-64 bg-[radial-gradient(ellipse_60%_100%_at_50%_100%,rgb(59_130_246/0.1),transparent)]"
      />
      <div className="relative mx-auto max-w-7xl px-4 py-24 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
            先跑起来，再改成你的
          </h2>
          <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            一条命令起本地环境，进后台看会话、模型、工具与审计，再决定从哪里开始改。
          </p>
          {user || !authEnabled ? null : (
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <Button
                render={<Link href={Pages.register} />}
                size="lg"
                className="bg-primary text-primary-foreground shadow-lg hover:bg-primary/90"
              >
                开始使用
                <ArrowRight data-icon="inline-end" />
              </Button>
              <Button
                render={<Link href={Pages.login} />}
                size="lg"
                variant="outline"
                className="border-border bg-card text-foreground hover:bg-muted hover:text-foreground"
              >
                <LogIn data-icon="inline-start" />
                登录
              </Button>
            </div>
          )}
        </Reveal>
      </div>
    </section>
  )
}
