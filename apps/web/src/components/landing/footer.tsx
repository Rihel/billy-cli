import Link from 'next/link'
import { TerminalSquare, ExternalLink } from 'lucide-react'
import { AppName, Pages, LandingAnchors, AdminUrl, ServerUrl } from '@/lib/constants'

type FooterLink = { href: string; label: string; external?: boolean }

const navGroups: { title: string; links: FooterLink[] }[] = [
  {
    title: '产品',
    links: [
      { href: Pages.home, label: '首页' },
      { href: LandingAnchors.why, label: '设计理念' },
      { href: LandingAnchors.features, label: '特性' },
      { href: LandingAnchors.choice, label: '选型' },
      { href: '/comparison', label: '竞品调研' },
      { href: LandingAnchors.ai, label: 'AI 能力' },
      { href: LandingAnchors.architecture, label: '架构' },
      { href: LandingAnchors.quickstart, label: '快速开始' },
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
      { href: ServerUrl, label: 'API 服务', external: true },
      { href: 'https://github.com', label: 'GitHub 仓库', external: true },
    ],
  },
]

/** 页脚：品牌 + 全量导航链接 */
export function Footer() {
  return (
    <footer className="border-t border-zinc-200/70 bg-zinc-50">
      <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-[1.4fr_repeat(3,1fr)]">
          <div>
            <Link href={Pages.home} className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-600/25">
                <TerminalSquare className="size-4.5" strokeWidth={2.2} />
              </span>
              <span className="font-heading text-[15px] font-semibold tracking-tight text-zinc-900">
                {AppName}
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-zinc-500">
              一套基于 NestJS 12 与 Next.js 16 的全栈应用 Monorepo 模板，数据结构先行、双前端开箱即用。
            </p>
          </div>

          {navGroups.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <h3 className="font-heading text-sm font-semibold text-zinc-700">
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
                        className="inline-flex items-center gap-1.5 text-sm text-zinc-500 transition-colors hover:text-indigo-600"
                      >
                        {link.label}
                        <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <Link
                        href={link.href}
                        className="inline-flex text-sm text-zinc-500 transition-colors hover:text-indigo-600"
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

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-zinc-200/70 pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-zinc-500">
            © {new Date().getFullYear()} {AppName}。保留所有权利。
          </p>
          <p className="font-mono text-xs text-zinc-500">Made with TypeScript · NestJS · Next.js</p>
        </div>
      </div>
    </footer>
  )
}
