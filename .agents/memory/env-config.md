# 环境变量加载口径与模板布局

> **查证优先级：必核** —— loader 行为 / 模板键 / 端口别名；改 `envConfigLoader` 或 `.env.example` 后重核。

## 结论（2026-11-20）

- **优先级与直觉相反**：6 个 Nest 服务用 `envConfigLoader` → `loadDotenv({ override: true })`，
  **存在 `.env` 时文件值覆盖同名真实进程环境变量**（`PORT=1234 pnpm dev:main` 会被 `.env` 盖掉）；
  容器 / k8s 不挂 `.env`，编排层 env 生效。admin / web（Next）相反：进程环境优先。
- **每个 app 只声明自己消费的分片**：main 15 个 schema 命名空间、runtime 12 个（无 `jwt` / `password` /
  `share` / `aiModel`）；`.env.example` 也不再互相复制。
- **端口别名**：内网服务专属键优先于 `PORT` —— `MODEL_GATEWAY_PORT` / `TOOL_GATEWAY_PORT` /
  `TOOL_WORKER_PORT` / `WORKSPACE_SERVICE_PORT`；模板只写 `PORT`，容器 / k8s 也写 `PORT`。
- **端口敏感键必须进模板**：带 schema 默认值的 URL（如 workspace-service 的 `MAIN_URL`，默认
  `http://127.0.0.1:9989`）不写进 `.env.example`，部署改端口后启动不报错、直到运行时才 `fetch failed`。
  加此类键时同步补模板与 `docs/guide/env.md`。
- **bootstrap 只生成 6 份 `.env`**（main / agent-runtime / capability-gateway / common-capability /
  admin / web）；model-gateway / workspace-service 要手动 `cp` 模板。
- **本次删掉的死键**：`TOOL_WORKER_URL`、`TOOL_WORKER_VERSION` / `ZONE`、common 侧
  `TOOL_WORKER_STALE_MS`、`WORKSPACE_DOCKER_BIN`、main 的整段 `agent` 命名空间、runtime 的
  `JWT_*` / `PASSWORD_*` / `SHARE_*` / `AUTH_ENABLED` / `MASTRA_*` 等；明细见
  `docs/guide/env.md` 的「已移除 / 不再读取的变量」。

## 依据

- 加载链路：`packages/kits/src/foundation/config/loaders/index.ts`（`override: true`）、各 app
  `src/app-config.ts`（schema + `mapXxxEnv`）。
- 文档：`docs/guide/env.md`（逐 app 变量表 + 核对脚本）、`docs/guide/deployment.md`（部署口径）。
- 结构：8 个 `apps/*/.env.example`（admin / web 的模板也在其中）。

## 核对命令

```bash
grep -n "override: true" packages/kits/src/foundation/config/loaders/index.ts
for app in main agent-runtime model-gateway capability-gateway common-capability workspace-service; do
  echo "== $app"; grep -cE '^#? *[A-Z_][A-Z0-9_]*=' apps/$app/.env.example
done
# 模板键是否都有读取方（应输出空）
for app in main agent-runtime model-gateway capability-gateway common-capability workspace-service; do
  grep -oE '^#? *[A-Z_][A-Z0-9_]*=' apps/$app/.env.example | sed -E 's/^# *//; s/=$//' | sort -u > /tmp/t.$app
  grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*|env\.[A-Z_][A-Z0-9_]*' apps/$app/src apps/$app/scripts 2>/dev/null \
    | sed -E 's/.*[.[]//; s/["'\'']\]$//' | sort -u > /tmp/c.$app
  echo "== $app 仅模板有：$(comm -23 /tmp/t.$app /tmp/c.$app | tr '\n' ' ')"
done
```

## 失效信号

`envConfigLoader` 改成不覆盖进程环境 / 模板与 schema 再次分叉（main 与 runtime 模板互相复制）/
端口别名被删；任一出现都回来改卡片与 `docs/guide/env.md`。
