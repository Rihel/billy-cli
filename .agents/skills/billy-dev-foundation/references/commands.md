# 常用命令（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 需要执行命令时查阅。

```bash
pnpm lint          # oxlint 全仓静态检查（correctness 全 error；0 warning 0 error 门禁）
pnpm lint:fix      # 自动修复安全项
pnpm lint:types    # 类型感知检查（tsgolint：悬空 Promise / await 非 Promise 等 5 条）
pnpm fmt           # oxfmt 全仓格式化（单引号 / 无分号 / 2 空格 / 100 列 / LF）
pnpm fmt:check     # 只检查不写入（提交前与 pre-push 用）
pnpm verify        # lint + lint:types + fmt:check + 三道 check 守卫（一条命令对齐钩子）
pnpm turbo run lint | lint:types | fmt:check | verify   # 同上的 turbo 根任务（带缓存）
pnpm turbo run verify typecheck test                    # 全套检查（verify + 每包 typecheck/test）
pnpm hooks:install # 手动重装 lefthook 钩子（pnpm install 已自动装）
pnpm dev:pkgs      # watch 构建 packages（http-client / kits / sdk / shared；ui 无 dev 脚本）
pnpm dev:server    # 启动 NestJS 服务（9989；node --watch --import tsx/esm src/main.ts）
pnpm dev:web       # Web 前台（9840）
pnpm dev:admin     # Admin 后台（9845）
pnpm build:web     # 仅构建 Web（turbo 带依赖包）
pnpm build:admin   # 仅构建 Admin（turbo 带依赖包）
pnpm build:server  # 仅构建 Server（turbo 带依赖包）
pnpm start:web     # 生产启动 Web（standalone，默认 9840；Docker 内 3001）
pnpm start:admin   # 生产启动 Admin（standalone，默认 9845）
pnpm start:server  # 生产启动 Server（9989）
pnpm kill:dev      # 一键停掉全部 dev 服务（Web / Admin / Server / packages watcher；--dry-run 仅预览）
pnpm kill:start    # 跨平台按端口停 start 服务（默认 9840 / 9845 / 9989；--dry-run / --force）
pnpm kill:port 3001  # 按指定端口停进程
pnpm build:pkgs    # 仅构建 packages（http-client / kits / sdk / shared；ui 直接用源码，无 build 脚本）
pnpm build         # 全量构建（turbo，按依赖拓扑）
pnpm typecheck     # 全量类型检查（turbo typecheck；覆盖 apps/web、apps/admin、packages/ui 三包）
pnpm test          # 全量单测（turbo test；http-client / kits / server / ui / web / admin 六包）
pnpm db:gen <Name> # 依据实体与数据库的差异生成迁移（写入 apps/server/src/database/migrations/，经 @app/server）
pnpm db:migrate    # 执行迁移（经 @app/server）
pnpm seed:admin    # 创建首个管理员（admin@billy.local / admin123）
pnpm docker:up     # Docker Compose 一键起依赖（postgres + redis + minio + server + web）
pnpm bootstrap     # 一键初始化引导：环境检查 → 依赖服务 → 生成 .env → install → 迁移 → 种子 → 冒烟
pnpm bootstrap -y  # 全默认非交互（--skip-docker / --skip-install / --skip-migrate / --skip-seed / --skip-smoke 可跳过指定步骤）
pnpm check:inject  # DI 装饰器一致性守卫（构造器 @Inject / providers @Injectable），违反返回非零退出码
pnpm check:ui       # 前端约定守卫（四条）：① packages/ui/src/components/ 自有组件必须在 src/index.ts 导出；
                    #   ② 前端包（apps/ 里依赖 next 的 + @repo/ui）必须声明 typecheck 脚本；
                    #   ③ 不得新增硬编码调色板类（存量按文件基线冻结，只许减少；视觉取值走设计系统语义 token）；
                    #   ④ app / @repo/ui 里的 @import "@repo/x/y.css" 必须在 packages/x/src/y.css 真实存在；
                    #   （字体回退链一致性：apps/*/src/app/layout.tsx 的 next/font 变量名与 packages/ui/src/globals.css 对齐）
```

> **不要用 `tsx` CLI 跑 server**：它同时挂 CJS 钩子，会让 CJS 依赖（pino / pg 等）`require` 到的
> `@nestjs/core` 与 ESM `import` 的是两份实例，启动报 `ApplicationConfig` 解析失败。
> 开发态统一 `node --watch --import tsx/esm`（package.json 的 `dev` / `seed:admin` 已如此）。
