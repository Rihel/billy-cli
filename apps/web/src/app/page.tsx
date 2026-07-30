import {
  Button,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@repo/ui"

// ── Data ──────────────────────────────────────────────

const packages = [
  {
    name: "@repo/aui",
    title: "Admin UI",
    desc: "Ant Design 6 后台组件库，Table、Form、Modal 企业级开箱即用。",
    tags: ["antd", "react", "tsdown"],
    tint: "from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/20",
    icon: "A",
    iconBg: "bg-amber-100 dark:bg-amber-900/50",
    iconFg: "text-amber-700 dark:text-amber-300",
  },
  {
    name: "@repo/ui",
    title: "前台 UI",
    desc: "shadcn/ui 60 个无头组件，极简设计，源码直连零运行时 CSS。",
    tags: ["shadcn", "tailwind", "base-ui"],
    tint: "from-zinc-50 to-neutral-50 dark:from-zinc-900/50 dark:to-neutral-900/50",
    icon: "U",
    iconBg: "bg-zinc-200 dark:bg-zinc-800",
    iconFg: "text-zinc-700 dark:text-zinc-300",
  },
  {
    name: "@repo/db",
    title: "数据库层",
    desc: "Drizzle ORM + PostgreSQL，类型安全查询与 Migration 管理。",
    tags: ["drizzle", "postgres", "zod"],
    tint: "from-blue-50 to-sky-50 dark:from-blue-950/30 dark:to-sky-950/20",
    icon: "D",
    iconBg: "bg-blue-100 dark:bg-blue-900/50",
    iconFg: "text-blue-700 dark:text-blue-300",
  },
  {
    name: "@repo/shared",
    title: "共享工具",
    desc: "Zod Schema、错误码字典、日志工具，全 workspace 复用。",
    tags: ["zod", "pino", "nanoid"],
    tint: "from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/20",
    icon: "S",
    iconBg: "bg-emerald-100 dark:bg-emerald-900/50",
    iconFg: "text-emerald-700 dark:text-emerald-300",
  },
  {
    name: "@repo/kits",
    title: "后端模块",
    desc: "NestJS 基础设施：Database、Redis、Logger、Storage。",
    tags: ["nestjs", "redis", "s3"],
    tint: "from-red-50 to-rose-50 dark:from-red-950/30 dark:to-rose-950/20",
    icon: "K",
    iconBg: "bg-red-100 dark:bg-red-900/50",
    iconFg: "text-red-700 dark:text-red-300",
  },
  {
    name: "@repo/sdk",
    title: "API 客户端",
    desc: "全类型化 HTTP SDK，Bearer / HMAC / OAuth2 多策略认证。",
    tags: ["axios", "auth", "types"],
    tint: "from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/20",
    icon: "C",
    iconBg: "bg-violet-100 dark:bg-violet-900/50",
    iconFg: "text-violet-700 dark:text-violet-300",
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
    name: "admin",
    title: "后台管理系统",
    port: "9845",
    desc: "Next.js 16 + Ant Design 6。登录注册、用户管理、Todo CRUD、文件存储。独立部署 Docker 就绪。",
    tags: ["Next.js 16", "Ant Design 6", "React Query", "Zustand"],
    tint: "from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/20",
    icon: "A",
    iconBg: "bg-amber-100 dark:bg-amber-900/50",
    iconFg: "text-amber-700 dark:text-amber-300",
    span: "lg:col-span-3",
  },
  {
    name: "web",
    title: "前台站点",
    port: "3000",
    desc: "shadcn/ui + Tailwind v4。落地页、博客、产品展示。TanStack Query + Form。",
    tags: ["shadcn/ui", "TanStack Query", "Tailwind v4"],
    tint: "from-zinc-50 to-neutral-50 dark:from-zinc-900/50 dark:to-neutral-900/50",
    icon: "W",
    iconBg: "bg-zinc-200 dark:bg-zinc-800",
    iconFg: "text-zinc-700 dark:text-zinc-300",
    span: "lg:col-span-2",
  },
]

// ── Components ────────────────────────────────────────

function SectionEyebrow({ children }: { children: string }) {
  return (
    <p className="mb-3 font-mono text-[11px] tracking-[0.2em] text-muted-foreground uppercase">
      {children}
    </p>
  )
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
      {children}
    </h2>
  )
}

function PackageCard({ pkg }: { pkg: (typeof packages)[number] }) {
  return (
    <Card
      className={`group flex flex-col border-transparent bg-gradient-to-br ${pkg.tint} transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:border-border`}
    >
      <CardHeader className="pb-3">
        <div className="mb-4 flex items-center gap-3">
          <span
            className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${pkg.iconBg} font-mono text-xs font-bold ${pkg.iconFg}`}
          >
            {pkg.icon}
          </span>
          <p className="font-mono text-xs text-muted-foreground">{pkg.name}</p>
        </div>
        <CardTitle className="text-lg">{pkg.title}</CardTitle>
        <CardDescription className="text-sm leading-relaxed">
          {pkg.desc}
        </CardDescription>
      </CardHeader>
      <CardContent className="mt-auto pt-0">
        <div className="flex flex-wrap gap-1.5">
          {pkg.tags.map((t) => (
            <Badge key={t} variant="secondary" className="text-[11px]">
              {t}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function AppCard({ app }: { app: (typeof apps)[number] }) {
  return (
    <Card
      className={`group ${app.span} border-transparent bg-gradient-to-br ${app.tint} transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:border-border`}
    >
      <CardHeader>
        <div className="mb-4 flex items-center gap-3">
          <span
            className={`inline-flex h-9 w-9 items-center justify-center rounded-lg ${app.iconBg} font-mono text-xs font-bold ${app.iconFg}`}
          >
            {app.icon}
          </span>
          <div>
            <p className="font-mono text-xs text-muted-foreground">
              @app/{app.name} :{app.port}
            </p>
            <CardTitle className="text-lg">{app.title}</CardTitle>
          </div>
        </div>
        <CardDescription className="text-sm leading-relaxed">
          {app.desc}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-1.5">
          {app.tags.map((t) => (
            <Badge key={t} variant="outline" className="text-[11px]">
              {t}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function Terminal() {
  const tree = `billy-cli
  apps/
    admin    后台管理 (Ant Design)
    web      前台站点 (shadcn/ui)
  packages/
    aui      Admin UI 组件
    ui       前台 UI 组件
    db       数据库层
    shared   共享工具
    kits     NestJS 模块
    sdk      API 客户端
  docker     Docker 部署
  scripts    CLI 脚手架
  docs       设计文档`

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 transition-shadow duration-500 hover:shadow-2xl hover:shadow-zinc-900/50">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-5 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
        <span className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
        <span className="ml-2 font-mono text-[11px] text-zinc-500">
          ~ billy-cli
        </span>
      </div>
      <pre className="overflow-auto p-5 font-mono text-xs leading-relaxed text-zinc-300 sm:text-sm">
        {tree}
      </pre>
    </div>
  )
}

function StatItem({ value, label }: { value: string; label: string }) {
  return (
    <div className="group rounded-2xl p-6 text-center transition-colors duration-300 hover:bg-muted/40">
      <p className="font-mono text-4xl font-bold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-2 text-sm text-muted-foreground">{label}</p>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      {/* ── Hero ── */}
      <section className="relative overflow-hidden px-4 pt-24 pb-16 sm:px-6 lg:px-8 lg:pt-36 lg:pb-28">
        {/* BG gradient blush */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10"
        >
          <div className="absolute top-0 right-0 h-[600px] w-[600px] -translate-y-1/2 translate-x-1/3 rounded-full bg-zinc-100/60 blur-3xl dark:bg-zinc-900/40" />
          <div className="absolute bottom-0 left-0 h-[500px] w-[500px] translate-y-1/3 -translate-x-1/4 rounded-full bg-amber-50/50 blur-3xl dark:bg-amber-950/20" />
        </div>

        <div className="mx-auto max-w-6xl">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
            <div className="space-y-7">
              <SectionEyebrow>Full-stack Monorepo Starter</SectionEyebrow>
              <h1 className="max-w-lg font-mono text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
                Billy CLI
              </h1>
              <p className="max-w-md text-lg leading-relaxed text-muted-foreground">
                pnpm workspace + Turborepo 全栈工程。NestJS 后端，
                Next.js 前后台双前端，PostgreSQL + Redis 基础设施。
              </p>
              <div className="flex flex-wrap gap-3 pt-2">
                <Button
                  size="lg"
                  className="transition-all duration-200 hover:scale-105 active:scale-95"
                >
                  pnpm install
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="transition-all duration-200 hover:scale-105 active:scale-95"
                >
                  pnpm dev
                </Button>
              </div>
            </div>
            <Terminal />
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Stats ── */}
      <section className="px-4 py-20 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl">
          <div className="grid grid-cols-2 sm:grid-cols-4">
            <StatItem value="60+" label="UI 组件" />
            <StatItem value="6" label="共享包" />
            <StatItem value="2" label="独立应用" />
            <StatItem value="4" label="后端服务" />
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Packages ── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-14">
            <SectionEyebrow>Packages</SectionEyebrow>
            <SectionTitle>6 个共享包，职责清晰</SectionTitle>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((pkg) => (
              <PackageCard key={pkg.name} pkg={pkg} />
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Apps ── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-14">
            <SectionTitle>独立部署，各自优化</SectionTitle>
            <p className="mt-3 text-muted-foreground">
              前后台独立构建，独立端口，Docker 一键编排。
            </p>
          </div>
          <div className="grid gap-8 lg:grid-cols-5">
            {apps.map((app) => (
              <AppCard key={app.name} app={app} />
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Tech Stack ── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <div className="mb-14">
            <SectionEyebrow>Stack</SectionEyebrow>
            <SectionTitle>技术栈</SectionTitle>
          </div>
          <Tabs defaultValue="frontend">
            <TabsList className="mb-10 w-full justify-start gap-1 bg-transparent p-0">
              {[
                ["frontend", "前端"],
                ["backend", "后端"],
                ["infra", "基础设施"],
              ].map(([v, l]) => (
                <TabsTrigger
                  key={v}
                  value={v}
                  className="rounded-lg px-5 py-2 text-sm data-[state=active]:bg-muted data-[state=active]:shadow-none"
                >
                  {l}
                </TabsTrigger>
              ))}
            </TabsList>
            {(["frontend", "backend", "infra"] as const).map((key) => (
              <TabsContent key={key} value={key}>
                <div className="overflow-hidden rounded-xl border">
                  {tech[key].map(([name, desc]) => (
                    <div
                      key={name}
                      className="flex items-start justify-between gap-4 bg-card px-6 py-4 transition-colors duration-200 hover:bg-muted/30"
                    >
                      <span className="text-sm font-medium">{name}</span>
                      <span className="text-sm text-muted-foreground text-right">
                        {desc}
                      </span>
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
      <section className="px-4 py-28 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-xl space-y-6 text-center">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            开始构建
          </h2>
          <p className="text-lg text-muted-foreground">
            MIT 协议，一套代码前后台全覆盖。
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-4">
            <Button
              size="lg"
              className="transition-all duration-200 hover:scale-105 active:scale-95"
            >
              pnpm install
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="transition-all duration-200 hover:scale-105 active:scale-95"
            >
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
