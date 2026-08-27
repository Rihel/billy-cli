# @app/server

Hono HTTP 边界 + 业务模块 + 实体/迁移（能力复用 `@repo/kits`）。

## Development

```bash
pnpm --filter @app/server dev
```

The server listens on `PORT` (default `9989`).

## Build

```bash
pnpm --filter @app/server build
pnpm --filter @app/server start:prod
```

Application capabilities live in `src/capabilities`, with each capability's
Effect tag and implementation kept in one file. HTTP endpoints live in
`src/features`; route factories obtain application dependencies through Effect
DI, validate input with shared Zod schemas, and execute core use cases through
the managed application runtime.
