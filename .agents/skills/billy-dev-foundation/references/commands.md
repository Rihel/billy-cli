# 常用命令（billy-dev-foundation 引用文件）

> 本文件是 `billy-dev-foundation` skill 的组成部分，由主 SKILL.md 引用。
> 需要执行命令时查阅。

```bash
pnpm dev:pkgs      # watch 构建 packages（http-client / di / kits / sdk / shared；ui 无 dev 脚本）
pnpm dev:server    # 启动 Hono 服务（9989）
pnpm dev:web       # Web 前台（9840）
pnpm dev:admin     # Admin 后台（9845）
pnpm build:pkgs    # 仅构建 packages（http-client / di / kits / sdk / shared / ui）
pnpm build         # 全量构建（turbo，按依赖拓扑）
pnpm db:gen <Name> # 依据实体与数据库的差异生成迁移（写入 apps/server/src/database/migrations/，经 @app/server）
pnpm db:migrate    # 执行迁移（经 @app/server）
pnpm seed:admin    # 创建首个管理员（admin@billy.local / admin123）
pnpm docker:up     # Docker Compose 一键起依赖（postgres + redis + minio + server + web）
pnpm cli           # 代码生成器（交互式）：package / client / service / crud 四类模板
pnpm cli -t crud -n <name>  # 非交互生成 CRUD 业务模块（实体 / repository / service / errors / features / schema）
```
