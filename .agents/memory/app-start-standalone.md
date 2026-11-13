# 本地 / 生产启动：Next standalone 的坑

**查证优先级：必核**（Next 版本、output 模式、端口约定、启动脚本变动后重核；命令在下方）

## 结论

- Next 16 的 `output: 'standalone'`（仅非 dev 构建生效）下 **`next start` 不兼容**，
  Next 会明确告警；启动必须 `node .next/standalone/apps/<app>/server.js`。
- standalone 目录按 `outputFileTracingRoot`（仓库根）落盘：web 是
  `.next/standalone/apps/web`，admin 是 `.next/standalone/apps/admin`。
- **2026-11-13 起统一走 `scripts/start-standalone.mjs`**（Node，跨平台）：
  `pnpm --filter @app/web start` / `@app/admin start` 分别传 `web 9840` / `admin 9845`；
  脚本把 `.next/static` 与 `public` 拷进 standalone，再起 `server.js`。
  历史坑：admin 旧 `start.sh` 曾误指 `apps/web`，且 `exec PORT=9845 node ...` 在 `sh` 下无效。
- 端口约定：server **9989**；web 本地 start 与 dev 一致为 **9840**，Docker 内由
  `Dockerfile.web` 的 `ENV PORT=3001` 覆盖；admin **9845**（dev 同为 9845）。

## 依据

- `apps/web/next.config.ts` / `apps/admin/next.config.ts`：`output: !isDev ? 'standalone' : undefined`
- `scripts/start-standalone.mjs`、`apps/web/package.json`、`apps/admin/package.json`
- `docker/Dockerfile.web`：`ENV PORT=3001`、`CMD node apps/web/server.js`

核对命令：

```bash
grep -n '"start"' apps/web/package.json apps/admin/package.json
ls scripts/start-standalone.mjs
grep -n "output" apps/web/next.config.ts apps/admin/next.config.ts
```

## 失效信号

Next 取消 standalone 输出、增加 admin 的 Dockerfile / compose 服务、改端口约定，
或把启动逻辑改成 `next start` 时重核。
