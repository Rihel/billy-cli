import Link from 'next/link'
import { TerminalSquare, ExternalLink } from 'lucide-react'
import { AppName, Pages, LandingAnchors, AdminUrl, PublicServerUrl } from '@/lib/constants'
import type { AuthUserModel } from '@repo/shared'

type FooterLink = { href: string; label: string; external?: boolean }

const navGroups: { title: string; links: FooterLink[] }[] = [
  {
    title: '产品',
    links: [
      { href: Pages.home, label: '首页' },
      { href: LandingAnchors.ai, label: 'AI 应用开发' },
      { href: LandingAnchors.observability, label: '可观测性' },
      { href: LandingAnchors.design, label: '设计系统' },
      { href: LandingAnchors.maintainability, label: '维护性' },
      { href: LandingAnchors.quickstart, label: '快速开始' },
      { href: '/comparison', label: '竞品调研' },
    ],
  },
  {
    title: '账号',
    links: [
      { href: Pages.login, label: '登录' },
      { href: Pages.register, label: '注册' },
      { href: Pages.forgotPassword, label: '忘记密码' },
      { href: Pages.resetPassword, label: '重置密码' },
    ],
  },
  {
    title: '服务',
    links: [
      { href: AdminUrl, label: '管理后台', external: true },
      { href: PublicServerUrl, label: 'API 服务', external: true },
      { href: 'https://github.com/Rihel/billy-cli', label: '代码仓库（GitHub）', external: true },
    ],
  },
]

export type FooterProps = {
  /** 服务端探测到的登录用户：已登录时整组隐藏「账号」入口 */
  user: AuthUserModel | null
  /** 用户体系开关：关闭时同样整组隐藏「账号」入口 */
  authEnabled: boolean
}

/** 页脚：品牌 + 全量导航链接（已登录或用户体系关闭时不展示登录 / 注册等账号入口） */
export function Footer({ user, authEnabled }: FooterProps) {
  const hideAccount = Boolean(user) || !authEnabled
  const groups = hideAccount ? navGroups.filter((group) => group.title !== '账号') : navGroups

  return (
    <footer className="border-t border-border/70 bg-muted">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div
          className={
            hideAccount
              ? 'grid grid-cols-1 gap-10 md:grid-cols-[1.4fr_repeat(2,1fr)]'
              : 'grid grid-cols-1 gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]'
          }
        >
          <div>
            <Link href={Pages.home} className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-brand to-violet-600 text-white shadow-md shadow-brand/25">
                <TerminalSquare className="size-4.5" strokeWidth={2.2} />
              </span>
              <span className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
                {AppName}
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              开箱即用的 AI 应用开发基座：会话、工具、连接器、可观测与设计系统都在仓库里。
            </p>
          </div>

          {groups.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <h3 className="font-heading text-sm font-semibold text-foreground">
                {group.title}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {group.links.map((link) => (
                  <li key={link.label}>
                    {link.external ? (
                      <a
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-brand"
                      >
                        {link.label}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="inline-flex text-sm text-muted-foreground transition-colors hover:text-brand"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-border/70 pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} {AppName}。保留所有权利。
          </p>
          <p className="font-mono text-xs text-muted-foreground">Made with TypeScript · NestJS · Next.js</p>
        </div>
      </div>
    </footer>
  )
}
