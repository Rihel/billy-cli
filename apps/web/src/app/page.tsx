'use client'

import { Header } from "@/components/Header"
import {
  Button,
  Badge,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@repo/ui"
import { useEffect, useRef, useState } from "react"

// ── Data ──────────────────────────────────────────────

const packages = [
  {
    name: "@repo/aui", title: "Admin UI",
    desc: "Ant Design 6 后台组件库，Table、Form、Modal 企业级开箱即用。",
    tags: ["antd", "react", "tsdown"],
    tint: "from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20",
    icon: "A", iconBg: "bg-amber-100 dark:bg-amber-900/50", iconFg: "text-amber-700 dark:text-amber-300",
    glow: "shadow-amber-200/50 dark:shadow-amber-500/10",
  },
  {
    name: "@repo/ui", title: "前台 UI",
    desc: "shadcn/ui 60 个无头组件，极简设计，源码直连零运行时 CSS。",
    tags: ["shadcn", "tailwind", "base-ui"],
    tint: "from-zinc-50 to-neutral-50 dark:from-zinc-900/50 dark:to-neutral-900/50",
    icon: "U", iconBg: "bg-zinc-200 dark:bg-zinc-800", iconFg: "text-zinc-700 dark:text-zinc-300",
    glow: "shadow-zinc-200/50 dark:shadow-zinc-500/10",
  },
  {
    name: "@repo/db", title: "数据库层",
    desc: "Drizzle ORM + PostgreSQL，类型安全查询与 Migration 管理。",
    tags: ["drizzle", "postgres", "zod"],
    tint: "from-blue-50 to-sky-50 dark:from-blue-950/30 dark:to-sky-950/20",
    icon: "D", iconBg: "bg-blue-100 dark:bg-blue-900/50", iconFg: "text-blue-700 dark:text-blue-300",
    glow: "shadow-blue-200/50 dark:shadow-blue-500/10",
  },
  {
    name: "@repo/shared", title: "共享工具",
    desc: "Zod Schema、错误码字典、日志工具，全 workspace 复用。",
    tags: ["zod", "pino", "nanoid"],
    tint: "from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20",
    icon: "S", iconBg: "bg-emerald-100 dark:bg-emerald-900/50", iconFg: "text-emerald-700 dark:text-emerald-300",
    glow: "shadow-emerald-200/50 dark:shadow-emerald-500/10",
  },
  {
    name: "@repo/kits", title: "后端模块",
    desc: "NestJS 基础设施：Database、Redis、Logger、Storage。",
    tags: ["nestjs", "redis", "s3"],
    tint: "from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/20",
    icon: "K", iconBg: "bg-red-100 dark:bg-red-900/50", iconFg: "text-red-700 dark:text-red-300",
    glow: "shadow-red-200/50 dark:shadow-red-500/10",
  },
  {
    name: "@repo/sdk", title: "API 客户端",
    desc: "全类型化 HTTP SDK，Bearer / HMAC / OAuth2 多策略认证。",
    tags: ["axios", "auth", "types"],
    tint: "from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/20",
    icon: "C", iconBg: "bg-violet-100 dark:bg-violet-900/50", iconFg: "text-violet-700 dark:text-violet-300",
    glow: "shadow-violet-200/50 dark:shadow-violet-500/10",
  },
]

const tech = {
  frontend: [
    ["Next.js 16", "RSC, Turbopack, App Router"],
    ["Ant Design 6", "企业级后台，CSS-in-JS 零运行时"],
    ["shadcn/ui", "Base UI 无头组件，60 个开箱即用"],
    ["Tailwind CSS v4", "原子化 CSS，JIT 零运行时"],
    ["TanStack Query", "服务端状态，自动缓存刷新"],
    ["TanStack Form", "类型安全表单"],
  ],
  backend: [
    ["NestJS 11", "模块化框架，AOP，依赖注入"],
    ["Drizzle ORM", "类型安全 SQL，Migration 管理"],
    ["PostgreSQL 17", "关系型数据库，游标分页"],
    ["Redis 7", "缓存 + Session + BullMQ 队列"],
    ["JWT + bcrypt", "无状态认证，密码哈希"],
    ["Zod v4", "运行时校验，DTO 验证"],
  ],
  infra: [
    ["pnpm workspace", "Monorepo 包管理，严格依赖隔离"],
    ["Turborepo", "增量构建，缓存优化"],
    ["Docker Compose", "PG + Redis + Server + Web 一键启动"],
    ["S3 / COS", "对象存储，预签名上传"],
    ["Pino", "结构化日志，Pretty Print"],
  ],
}

const apps = [
  {
    name: "admin", title: "后台管理系统", port: "9845",
    desc: "Next.js 16 + Ant Design 6。登录注册、用户管理、Todo CRUD、文件存储。独立部署 Docker 就绪。",
    tags: ["Next.js 16", "Ant Design 6", "React Query", "Zustand"],
    tint: "from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/20",
    icon: "A", iconBg: "bg-amber-100 dark:bg-amber-900/50", iconFg: "text-amber-700 dark:text-amber-300",
    span: "lg:col-span-3", glow: "shadow-amber-200/50 dark:shadow-amber-500/10",
  },
  {
    name: "web", title: "前台站点", port: "3000",
    desc: "shadcn/ui + Tailwind v4。落地页、博客、产品展示。TanStack Query + Form。",
    tags: ["shadcn/ui", "TanStack Query", "Tailwind v4"],
    tint: "from-zinc-50 to-neutral-50 dark:from-zinc-900/50 dark:to-neutral-900/50",
    icon: "W", iconBg: "bg-zinc-200 dark:bg-zinc-800", iconFg: "text-zinc-700 dark:text-zinc-300",
    span: "lg:col-span-2", glow: "shadow-zinc-200/50 dark:shadow-zinc-500/10",
  },
]

const stats = [
  { value: 60, suffix: "+", label: "UI 组件" },
  { value: 6, suffix: "", label: "共享包" },
  { value: 2, suffix: "", label: "独立应用" },
  { value: 4, suffix: "", label: "后端服务" },
]

const marqueeItems = [
  "Next.js 16", "NestJS 11", "PostgreSQL 17", "Redis 7",
  "Drizzle ORM", "Tailwind CSS v4", "shadcn/ui", "Ant Design 6",
  "TanStack Query", "Zod v4", "Docker Compose", "Turborepo",
  "pnpm workspace", "TypeScript", "S3 / COS", "JWT Auth",
]

// ── Hooks ─────────────────────────────────────────────

function useInView(ref: React.RefObject<HTMLElement | null>, threshold = 0.15) {
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setInView(true); obs.disconnect() } },
      { threshold }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [ref, threshold])
  return inView
}

function useCountUp(target: number, duration = 2000, start = false) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!start) return
    let startTime: number | null = null
    let raf: number
    const step = (timestamp: number) => {
      if (!startTime) startTime = timestamp
      const progress = Math.min((timestamp - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setCount(Math.floor(eased * target))
      if (progress < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, duration, start])
  return count
}

// ── Animated Components ───────────────────────────────

function SectionEyebrow({ children }: { children: string }) {
  return (
    <p className="mb-3 font-mono text-[11px] tracking-[0.2em] text-muted-foreground uppercase">
      {children}
    </p>
  )
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">{children}</h2>
  )
}

function Marquee({ items, reverse = false, speed = 30 }: { items: string[], reverse?: boolean, speed?: number }) {
  return (
    <div className="relative flex overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
      <div
        className="flex shrink-0 animate-marquee gap-3 py-3"
        style={{ animationDirection: reverse ? 'reverse' : 'normal', animationDuration: `${speed}s` }}
      >
        {[...items, ...items].map((item, i) => (
          <span
            key={i}
            className="inline-flex items-center rounded-full border bg-card px-4 py-1.5 text-sm font-medium text-muted-foreground shadow-sm transition-colors hover:text-foreground hover:border-foreground/20"
          >
            {item}
          </span>
        ))}
      </div>
      <div
        className="flex shrink-0 animate-marquee gap-3 py-3"
        style={{ animationDirection: reverse ? 'reverse' : 'normal', animationDuration: `${speed}s` }}
        aria-hidden
      >
        {[...items, ...items].map((item, i) => (
          <span
            key={`dup-${i}`}
            className="inline-flex items-center rounded-full border bg-card px-4 py-1.5 text-sm font-medium text-muted-foreground shadow-sm"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  )
}

function ScrollReveal({ children, className = "", delay = 0 }: { children: React.ReactNode, className?: string, delay?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref)
  return (
    <div
      ref={ref}
      className={`transition-all duration-700 ease-out ${inView ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"} ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  )
}

function StatItem({ value, suffix, label, inView }: { value: number, suffix: string, label: string, inView: boolean }) {
  const count = useCountUp(value, 2000, inView)
  return (
    <div className="text-center">
      <div className="text-4xl font-bold tabular-nums sm:text-5xl">
        {count}{suffix}
      </div>
      <div className="mt-2 text-sm text-muted-foreground">{label}</div>
    </div>
  )
}

function TiltCard({ children, glow = "", className = "" }: { children: React.ReactNode, glow?: string, className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({})

  const handleMove = (e: React.MouseEvent) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width - 0.5
    const y = (e.clientY - rect.top) / rect.height - 0.5
    setStyle({
      transform: `perspective(800px) rotateY(${x * 6}deg) rotateX(${-y * 6}deg) scale3d(1.02,1.02,1.02)`,
      boxShadow: `${-x * 20}px ${y * 20}px 40px rgba(0,0,0,0.06)`,
      transition: "transform 0.1s ease-out, box-shadow 0.1s ease-out",
    })
  }

  const handleLeave = () => {
    setStyle({
      transform: "perspective(800px) rotateY(0deg) rotateX(0deg) scale3d(1,1,1)",
      boxShadow: "",
      transition: "transform 0.5s ease-out, box-shadow 0.5s ease-out",
    })
  }

  return (
    <div
      ref={ref}
      className={className}
      style={style}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      {children}
    </div>
  )
}

function Terminal() {
  const [text, setText] = useState("")
  const fullText = "docker compose up -d"

  useEffect(() => {
    let i = 0
    const timer = setInterval(() => {
      if (i <= fullText.length) {
        setText(fullText.slice(0, i))
        i++
      } else {
        clearInterval(timer)
      }
    }, 80)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="w-full max-w-lg overflow-hidden rounded-xl border bg-zinc-950 shadow-2xl shadow-zinc-900/20">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
        <span className="ml-2 font-mono text-[11px] text-zinc-500">Terminal</span>
      </div>
      <div className="px-5 py-4">
        <p className="font-mono text-sm text-green-400">
          <span className="text-zinc-500">$ </span>
          {text}
          <span className="inline-block w-2 h-4 bg-green-400 ml-0.5 align-middle animate-pulse" />
        </p>
      </div>
    </div>
  )
}

function FloatingShape({ className }: { className: string }) {
  return (
    <div className={`absolute rounded-full opacity-[0.07] dark:opacity-[0.04] animate-float ${className}`} />
  )
}

// ── Page ──────────────────────────────────────────────

export default function HomePage() {
  const statsRef = useRef<HTMLDivElement>(null)
  const statsInView = useInView(statsRef, 0.3)

  return (
    <div className="min-h-screen">
      <style>{`
        @keyframes marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px) rotate(0deg); }
          33% { transform: translateY(-20px) rotate(1deg); }
          66% { transform: translateY(10px) rotate(-1deg); }
        }
        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .animate-marquee { animation: marquee var(--marquee-speed, 30s) linear infinite; }
        .animate-float { animation: float 8s ease-in-out infinite; }
        .animate-gradient {
          background-size: 200% 200%;
          animation: gradient-shift 6s ease infinite;
        }
        @keyframes glow-pulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 0.7; transform: scale(1.3); }
        }
        .animate-glow-pulse { animation: glow-pulse 3s ease-in-out infinite; }
      `}</style>

      <Header />

      {/* ── Hero ── */}
      <section className="relative overflow-hidden px-4 pb-20 pt-24 sm:px-6 sm:pt-32 sm:pb-28 lg:px-8">
        {/* Background effects */}
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="h-[600px] w-[600px] animate-glow-pulse rounded-full bg-gradient-to-br from-blue-500/10 via-violet-500/10 to-transparent blur-3xl" />
          </div>
          <FloatingShape className="h-40 w-40 bg-blue-400 top-[15%] left-[10%]" />
          <FloatingShape className="h-24 w-24 bg-violet-400 top-[60%] right-[8%]" style={{ animationDelay: '2s' }} />
          <FloatingShape className="h-32 w-32 bg-amber-400 bottom-[20%] left-[20%]" style={{ animationDelay: '4s' }} />
          <FloatingShape className="h-20 w-20 bg-emerald-400 top-[30%] right-[25%]" style={{ animationDelay: '6s' }} />
        </div>

        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-6 inline-flex items-center gap-2 rounded-full border bg-muted/50 px-4 py-1.5 text-sm backdrop-blur">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
            pnpm workspace + Turborepo
          </div>

          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
            <span className="animate-gradient bg-gradient-to-r from-zinc-900 via-blue-600 to-zinc-900 bg-clip-text text-transparent dark:from-zinc-100 dark:via-blue-400 dark:to-zinc-100">
              全栈 Monorepo
            </span>
            <br />
            <span className="text-zinc-400 dark:text-zinc-500">一个命令启动全部</span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground leading-relaxed">
            NestJS 后端 · Next.js 双前端 · PostgreSQL + Redis · Docker 一键编排。
            企业级脚手架，前后台独立部署。
          </p>

          <div className="mt-10 flex flex-wrap justify-center gap-4">
            <Button size="lg" className="group relative overflow-hidden transition-all duration-300 hover:scale-105 active:scale-95">
              <span className="relative z-10">pnpm install</span>
              <div className="absolute inset-0 -z-0 bg-gradient-to-r from-blue-600 to-violet-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            </Button>
            <Button size="lg" variant="outline" className="transition-all duration-300 hover:scale-105 active:scale-95 hover:border-foreground/30">
              查看文档 →
            </Button>
          </div>

          <div className="mt-16">
            <Terminal />
          </div>
        </div>
      </section>

      {/* ── Marquee ── */}
      <section className="py-12">
        <Marquee items={marqueeItems} speed={35} />
        <Marquee items={marqueeItems.slice().reverse()} reverse speed={28} />
      </section>

      <Separator />

      {/* ── Stats ── */}
      <section ref={statsRef} className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-8">
            {stats.map((s) => (
              <StatItem key={s.label} value={s.value} suffix={s.suffix} label={s.label} inView={statsInView} />
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Packages ── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-14">
            <ScrollReveal>
              <SectionEyebrow>Packages</SectionEyebrow>
              <SectionTitle>6 个共享包，职责清晰</SectionTitle>
            </ScrollReveal>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((pkg, i) => (
              <ScrollReveal key={pkg.name} delay={i * 100}>
                <TiltCard glow={pkg.glow}>
                  <div className={`group relative overflow-hidden rounded-xl border bg-gradient-to-br ${pkg.tint} p-6 transition-shadow duration-300 hover:shadow-lg ${pkg.glow}`}>
                    <div className="flex items-start justify-between mb-4">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${pkg.iconBg} ${pkg.iconFg} font-bold text-sm`}>
                        {pkg.icon}
                      </div>
                      <div className="flex gap-1.5">
                        {pkg.tags.slice(0, 2).map((t) => (
                          <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                        ))}
                      </div>
                    </div>
                    <h3 className="font-semibold mb-1.5">{pkg.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{pkg.desc}</p>
                    <code className="mt-4 block text-xs text-muted-foreground/60">{pkg.name}</code>
                  </div>
                </TiltCard>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Apps ── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-14">
            <ScrollReveal>
              <SectionTitle>独立部署，各自优化</SectionTitle>
              <p className="mt-3 text-muted-foreground">
                前后台独立构建，独立端口，Docker 一键编排。
              </p>
            </ScrollReveal>
          </div>
          <div className="grid gap-8 lg:grid-cols-5">
            {apps.map((app, i) => (
              <ScrollReveal key={app.name} delay={i * 150}>
                <TiltCard glow={app.glow}>
                  <div className={`group relative overflow-hidden rounded-xl border bg-gradient-to-br ${app.tint} p-6 transition-shadow duration-300 hover:shadow-lg ${app.glow} ${app.span}`}>
                    <div className="flex items-start justify-between mb-4">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${app.iconBg} ${app.iconFg} font-bold text-sm`}>
                        {app.icon}
                      </div>
                      <span className="font-mono text-xs text-muted-foreground/60">:{app.port}</span>
                    </div>
                    <h3 className="font-semibold mb-1.5">{app.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">{app.desc}</p>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {app.tags.map((t) => (
                        <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>
                      ))}
                    </div>
                  </div>
                </TiltCard>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Tech Stack ── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-14">
            <ScrollReveal>
              <SectionEyebrow>Stack</SectionEyebrow>
              <SectionTitle>技术栈</SectionTitle>
            </ScrollReveal>
          </div>
          <Tabs defaultValue="frontend">
            <TabsList className="mb-10 w-full justify-start gap-1 bg-transparent p-0">
              {[["frontend", "前端"], ["backend", "后端"], ["infra", "基础设施"]].map(([v, l]) => (
                <TabsTrigger key={v} value={v} className="rounded-lg px-5 py-2 text-sm data-[state=active]:bg-muted data-[state=active]:shadow-none">
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>
            {(["frontend", "backend", "infra"] as const).map((key) => (
              <TabsContent key={key} value={key}>
                <div className="overflow-hidden rounded-xl border">
                  {tech[key].map(([name, desc], i) => (
                    <div
                      key={name}
                      className="flex items-start justify-between gap-4 bg-card px-6 py-4 transition-all duration-200 hover:bg-muted/50 hover:pl-8"
                    >
                      <span className="text-sm font-medium">{name}</span>
                      <span className="text-sm text-muted-foreground text-right">{desc}</span>
                    </div>
                  ))}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </div>
      </section>

      <Separator />

      {/* ── CTA ── */}
      <section className="relative overflow-hidden px-4 py-28 sm:px-6 lg:px-8">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="h-[400px] w-[400px] animate-glow-pulse rounded-full bg-gradient-to-br from-blue-500/10 via-violet-500/10 to-transparent blur-3xl" />
          </div>
        </div>
        <div className="mx-auto max-w-xl space-y-6 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            开始构建
          </h2>
          <p className="text-lg text-muted-foreground">
            MIT 协议，一套代码前后台全覆盖。
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-4">
            <Button size="lg" className="group relative overflow-hidden transition-all duration-300 hover:scale-105 active:scale-95">
              <span className="relative z-10">pnpm install</span>
              <div className="absolute inset-0 -z-0 bg-gradient-to-r from-blue-600 to-violet-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
            </Button>
            <Button size="lg" variant="outline" className="transition-all duration-300 hover:scale-105 active:scale-95 hover:border-foreground/30">
              查看文档
            </Button>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="font-mono text-xs text-muted-foreground">Billy CLI</p>
          <div className="flex gap-6 font-mono text-xs text-muted-foreground">
            <span>pnpm workspace</span>
            <span>Turborepo</span>
            <span>MIT</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
