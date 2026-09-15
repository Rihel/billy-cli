# 常用命令（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 需要执行命令时查阅。

```bash
pnpm dev:pkgs      # watch 构建 packages（http-client / kits / sdk / shared；ui 无 dev 脚本）
pnpm dev:server    # 启动 NestJS 服务（9989；node --watch --import tsx/esm src/main.ts）
pnpm dev:web       # Web 前台（9840）
pnpm dev:admin     # Admin 后台（9845）
pnpm kill:dev      # 一键停掉全部 dev 服务（Web / Admin / Server / packages watcher；--dry-run 仅预览）
pnpm build:pkgs    # 仅构建 packages（http-client / kits / sdk / shared / ui）
pnpm build         # 全量构建（turbo，按依赖拓扑）
pnpm db:gen <Name> # 依据实体与数据库的差异生成迁移（写入 apps/server/src/database/migrations/，经 @app/server）
pnpm db:migrate    # 执行迁移（经 @app/server）
pnpm seed:admin    # 创建首个管理员（admin@billy.local / admin123）
pnpm docker:up     # Docker Compose 一键起依赖（postgres + redis + minio + server + web）
pnpm bootstrap     # 一键初始化引导：环境检查 → 依赖服务 → 生成 .env → install → 迁移 → 种子 → 冒烟
pnpm bootstrap -y  # 全默认非交互（--skip-docker / --skip-install / --skip-migrate / --skip-seed / --skip-smoke 可跳过指定步骤）
pnpm cli           # 代码生成器（交互式）：package / client / service / crud 四类模板
pnpm cli -t crud -n <name>  # 非交互生成 CRUD 业务模块（实体 / repository / service / controller / module / schema）
pnpm check:inject  # DI 装饰器一致性守卫（构造器 @Inject / providers @Injectable），违反返回非零退出码
pnpm check:scaffold # 脚手架模板守卫：导入名 + service 骨架整体渲染 + crud 模块整体渲染（真实 CLI 生成后类型检查），防模板与工作区包漂移
                    #   前提：刚改过 packages 源码要先 pnpm build:pkgs（tsc 读的是 dist 声明），脚本会告警；crud 检查会临时改动 shared 的 schema/index 与错误码字典，跑完自动还原
```

> **不要用 `tsx` CLI 跑 server**：它同时挂 CJS 钩子，会让 CJS 依赖（pino / pg 等）`require` 到的
> `@nestjs/core` 与 ESM `import` 的是两份实例，启动报 `ApplicationConfig` 解析失败。
> 开发态统一 `node --watch --import tsx/esm`（package.json 的 `dev` / `seed:admin` 已如此）。
