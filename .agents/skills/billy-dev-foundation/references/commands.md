# 常用命令（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 需要执行命令时查阅。

```bash
pnpm lint          # oxlint 全仓静态检查（correctness 全 error；0 warning 0 error 门禁）
pnpm lint:fix      # 自动修复安全项
pnpm lint:types    # 类型感知检查（tsgolint：悬空 Promise / await 非 Promise 等 5 条）
pnpm fmt           # oxfmt 全仓格式化（单引号 / 无分号 / 2 空格 / 100 列 / LF）
pnpm fmt:check     # 只检查不写入（提交前与 pre-push 用）
pnpm verify        # lint + lint:types + fmt:check + 四道 check 守卫（inject / mastra / redis-raw / ui）
pnpm turbo run lint | lint:types | fmt:check | verify   # 同上的 turbo 根任务（带缓存）
pnpm turbo run verify typecheck test                    # 全套检查（verify + 每包 typecheck/test）
pnpm hooks:install # 手动重装 lefthook 钩子（pnpm install 已自动装）
pnpm dev:pkgs      # watch 构建有 dev 脚本的包（shared / kits / http-client / sdk / contracts / internal-sdk）
pnpm dev:main      # 启动公网 BFF（@app/main，9989；node --watch --import tsx/esm src/main.ts）
pnpm dev:runtime   # 启动 agent loop（@app/agent-runtime，9990）
pnpm dev:stack     # 一条命令起后端全套：main / agent-runtime / model-gateway / capability-gateway / common-capability
pnpm dev:tools     # capability-gateway（9993）+ common-capability（9994）
pnpm dev:web       # Web 前台（9840）
pnpm dev:admin     # Admin 后台（9845）
pnpm build:web     # 仅构建 Web（turbo 带依赖包）
pnpm build:admin   # 仅构建 Admin（turbo 带依赖包）
pnpm build:main    # 仅构建 main（turbo 带依赖包）
pnpm build:runtime # 仅构建 agent-runtime（turbo 带依赖包）
pnpm start:web     # 生产启动 Web（standalone，默认 9840；Docker 内 3001）
pnpm start:admin   # 生产启动 Admin（standalone，默认 9845）
pnpm start:main    # 生产启动 main（9989）
pnpm start:runtime # 生产启动 agent-runtime（9990，只给 main 调）
pnpm start:stack   # 生产启动全套（后端 5 个 + admin 9845 + web 9840；需先 pnpm build）
pnpm kill:dev      # 一键停掉全部 dev 服务（Web / Admin / main / runtime / tools / packages watcher；--dry-run 仅预览）
pnpm kill:start    # 跨平台按端口停 start 服务（默认 9840 / 9845 / 9989 / 9990 / 9992 / 9993 / 9994；--dry-run / --force）
pnpm kill:port 3001  # 按指定端口停进程
pnpm build:pkgs    # 仅构建 packages（含只有 build 的 db / ai-data / web-runtime；ui 直接用源码）
pnpm build         # 全量构建（turbo，按依赖拓扑）
pnpm typecheck     # 全量类型检查（turbo typecheck；覆盖 web / admin / main / agent-runtime / 各 packages）
pnpm test          # 全量单测（turbo test；各 app 与 packages 分别跑）
pnpm db:gen <Name> # 依实体与数据库的差异生成迁移（写入 packages/db/src/migrations/；命令由 @repo/db 执行）
pnpm db:migrate    # 执行迁移（由 @repo/db 执行；实体 / 迁移的事实源也在 @repo/db）
pnpm seed:admin    # 创建首个管理员（admin@billy.local / admin123；根脚本指向 @app/main）
pnpm docker:up     # Docker Compose 一键起全套（postgres + redis + minio + main + agent-runtime + web）
pnpm bootstrap     # 一键初始化引导：环境检查 → 依赖服务 → 生成四份 .env（main / agent-runtime / admin / web）→ install → 迁移 → 种子 → 冒烟
pnpm bootstrap -y  # 全默认非交互（--skip-docker / --skip-install / --skip-migrate / --skip-seed / --skip-smoke 可跳过指定步骤）
pnpm check:inject  # DI 装饰器一致性守卫（构造器 @Inject / providers @Injectable），违反返回非零退出码
pnpm check:ui       # 前端约定守卫（四条）：① packages/ui/src/components/ 自有组件必须在 src/index.ts 导出；
                    #   ② 前端包（apps/ 里依赖 next 的 + @repo/ui）必须声明 typecheck 脚本；
                    #   ③ 不得新增硬编码调色板类（存量按文件基线冻结，只许减少；视觉取值走设计系统语义 token）；
                    #   ④ app / @repo/ui 里的 @import "@repo/x/y.css" 必须在 packages/x/src/y.css 真实存在；
                    #   （字体回退链一致性：apps/*/src/app/layout.tsx 的 next/font 变量名与 packages/ui/src/globals.css 对齐）
```

> **不要用 `tsx` CLI 跑 main / agent-runtime**：它同时挂 CJS 钩子，会让 CJS 依赖（pino / pg 等）
> `require` 到的 `@nestjs/core` 与 ESM `import` 的是两份实例，启动报 `ApplicationConfig` 解析失败。
> 开发态统一 `node --watch --import tsx/esm`（两个 app 的 `dev` / `seed:admin` 已如此）。
