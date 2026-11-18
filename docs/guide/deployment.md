# 部署

> 本地依赖、环境变量、Docker 镜像、Kubernetes 与前置反向代理。
> 架构与配置链路见 [architecture.md](./architecture.md)。

## 环境变量（手动）

`pnpm bootstrap` 会自动从模板生成，也可手动复制（拆成 main / runtime 后是**两份后端 .env**）：

```bash
cp apps/main/.env.example apps/main/.env
cp apps/agent-runtime/.env.example apps/agent-runtime/.env
cp apps/admin/.env.example apps/admin/.env
cp apps/web/.env.local.example apps/web/.env.local
```

`apps/main/.env` 关键项（完整模板见 `apps/main/.env.example`）：

```env
PORT=9989                                                # main 端口（前端 / SDK 都连它）
DB_URL=postgresql://root:pg1234@localhost:5432/billy-cli   # 默认端口 5432；compose 映射 15432
REDIS_URL=redis://localhost:6379/0                          # 默认端口 6379；compose 映射 6380
JWT_SECRET=dev-secret-change-in-production                  # 生产务必替换
AUTH_ENABLED=true                                           # false 关闭鉴权（clone 自用）
OBJECT_STORAGE_ENDPOINT=http://localhost:9000               # 默认端口 9000；compose 映射 19000
SHARE_INTERNAL_SECRET=                                      # 文件分享；空 = 分享内容一律 404
# main → runtime 的内部调用（缺一不可）
AGENT_RUNTIME_URL=http://127.0.0.1:9990
AGENT_INTERNAL_TOKEN=dev-agent-internal
# 流式对话必需：runtime 的输出经 Kafka 回 main 的 SSE
# （模板默认 localhost:9092；用仓库 compose 时映射到 29092）
KAFKA_BROKERS=127.0.0.1:29092
```

`apps/agent-runtime/.env` 关键项（与 main **共用 DB / Redis**，另有自己的端口与内部令牌）：

```env
PORT=9990                                                   # runtime 端口（只给 main 调，不对公网）
DB_URL=postgresql://root:pg1234@localhost:5432/billy-cli
REDIS_URL=redis://localhost:6379/0
AGENT_INTERNAL_TOKEN=dev-agent-internal                     # 必须与 main 的值一致
KAFKA_BROKERS=127.0.0.1:29092                               # 输出事件必需（模板默认 9092，compose 映射 29092）
AGENT_COMMAND_ENABLED=false                                 # 命令执行，默认关闭
AGENT_WORKSPACE_MODE=enforce                                # 命令隔离：沙箱不可用即拒绝执行（fail closed）
```

> 两份 `.env.example` 都已带 `AGENT_INTERNAL_TOKEN=dev-agent-internal`，`pnpm bootstrap` 直接生成；
> 两端取值必须一致，否则 `/internal/agent/*` 全部 401。

**Kafka（可选，只有连接器同步用）**：`docker compose --profile kafka up -d` 起 Kafka 与 kafka-ui，再执行
`scripts/kafka-create-topics.sh` 建 `app.ai.connector.sync`。流式对话**不再依赖 Kafka**（2026-11-15 起
走 Redis pub/sub 定向频道），没配 `KAFKA_BROKERS` 时连接器同步仍能靠 Redis EventBus + 幂等补偿收敛。

`OBJECT_STORAGE_ENDPOINT` **可以不配**：对象存储是可选能力（`s3` 下不配 endpoint 即未启用，
`cos` 由 `OBJECT_STORAGE_PROVIDER` 决定），未配置或 MinIO / S3 不可达时服务照常启动，
只有上传 / 下载 / 附件读取等真正用到存储的接口才报「对象存储未配置或不可用」。

`SHARE_INTERNAL_SECRET` 是文件分享的内部密钥：main 的 `/share/resolve` 与 admin 的
`/api/s/:token/content` 必须一致；不配只关闭字节下发（分享页取不到内容，`/api/s/*` 返回 404），
其余功能不受影响。admin 侧读的是**运行时**环境变量（`apps/admin/.env` / 容器环境），不随构建内联。

AI 命令执行的执行环境另由 `AGENT_WORKSPACE_MODE`（默认 `enforce`）、
`AGENT_WORKSPACE_SANDBOX_NETWORK`（默认 `deny`）、`AGENT_WORKSPACE_PROBE_TIMEOUT_MS` 控制；
`AGENT_COMMAND_WORK_DIR` 同时是命令与文件工具的工作区根。完整 `AGENT_*` 见 `apps/main/.env.example`（runtime 用同一份模板）。

`apps/web/.env.local` 与 `apps/admin/.env` 使用默认值即可（不配置时代码有默认值兜底；分享功能需另配
`SHARE_INTERNAL_SECRET`，见上）。

分享密钥 `SHARE_INTERNAL_SECRET` 只在 **admin 与 main** 两端配置（两边的 `.env.example` 都已列出），
取值必须一致；web 模板不含它（web 没有分享页）。不配置只关闭分享字节下发，不影响其它功能。

## 构建与启动（生产）

```bash
# 全量构建（turbo，按依赖拓扑）；也可单独构建某个应用（会自动构建其依赖包）
pnpm build
# pnpm build:web / pnpm build:admin / pnpm build:main / pnpm build:runtime

# 分别启动（main 依赖 runtime 在 9990；流式对话还依赖 Kafka）
pnpm start:main      # 公网 BFF：9989
pnpm start:runtime   # agent loop：9990（只给 main 调，不要暴露到公网）
pnpm start:web       # standalone，默认 9840（与 dev 一致；Docker 内由 ENV PORT=3001 覆盖）
pnpm start:admin     # standalone，默认 9845（PORT 可覆盖）

# 或 Docker Compose（postgres + redis + minio + main + agent-runtime + web）
pnpm docker:up

# 停止本地 start 起的进程（跨平台，默认 9840 / 9845 / 9989 / 9990 / 9993 / 9994）
pnpm kill:start
```

> `lsof` 在某些情况下查不到监听进程（进程属于其它用户、容器端口转发、或没装 lsof）。
> `kill:start` 会用 TCP 连接探针独立判断端口是否真的在监听：查不到进程时明确报
> 「在监听但定位不到进程」并给出 `sudo lsof` / `netstat` / `docker ps` 排查命令，不会误报端口空闲。

## Docker

### Compose 服务（依赖一键起）

```bash
docker compose up -d postgres redis minio   # 仅基础设施
docker compose up -d --build                # 全部（migrate + main + runtime + gateway + worker + web + 依赖）
docker compose --profile kafka up -d        # 可选：追加 Kafka + 控制台
```

| 服务     | 镜像 / 构建             | 端口映射                    |
| -------- | ----------------------- | --------------------------- |
| postgres | pgvector/pgvector:pg17  | `15432:5432`（init-db.sql 只做库级设置，建表由迁移负责）|
| redis    | redis:7-alpine          | `6380:6379`                 |
| minio    | minio/minio             | `19000:9000` / `19001:9001` |
| main     | docker/Dockerfile.main  | `9989:9989`（公网入口）      |
| agent-runtime | docker/Dockerfile.agent-runtime | 仅 `expose 9990`，**不映射宿主端口**；只由 main 通过 `AGENT_RUNTIME_URL=http://agent-runtime:9990` 调用 |
| model-gateway | docker/Dockerfile.model-gateway | 仅 `expose 9992`；runtime 通过 `MODEL_GATEWAY_URL=http://model-gateway:9992` 调用（4 套协议适配、持有供应商 key） |
| migrate  | docker/Dockerfile.agent-runtime | 一次性 Job，执行 `@repo/db` 迁移 |
| common-capability | docker/Dockerfile.common-capability | 仅 `expose 9994` |
| capability-gateway | docker/Dockerfile.capability-gateway | 仅 `expose 9993` |
| web      | docker/Dockerfile.web   | `3001:3001`                 |
| admin    | docker/Dockerfile.admin | `9846:9845`（避开本机 dev 9845） |
| kafka  ¹ | confluentinc/cp-kafka:7.4.8 | `29092:29092`            |
| kafka-ui ¹ | provectuslabs/kafka-ui | `8085:8080`               |
| zookeeper ¹ | confluentinc/cp-zookeeper:7.4.8 | `22181:2181`      |

¹ 这三个服务带 `profiles: ["kafka"]`，**不指定 profile 不会启动**。启用后把 main 与
runtime 的 `KAFKA_BROKERS` 都设为 `kafka:9092`（容器内）或 `127.0.0.1:29092`（宿主机直连）；
不配置 `KAFKA_BROKERS` 时 main 会降级为直接转发 runtime SSE（单机可用）；生产仍建议启用 Kafka。

MinIO 在 compose 里**默认随 `docker compose up` 启动**，但对象存储本身是可选能力：
不用上传 / 附件 / 分享时可以不启它（`docker compose up -d postgres redis main agent-runtime web`），
服务照常运行，只是存储相关接口报「未配置或不可用」。

> **compose 已按拆分后的形态编排**：`x-app-env` 锚点保证 main 与 agent-runtime 拿到完全一致的
> DB / Redis / JWT / 对象存储配置和同一个 `AGENT_INTERNAL_TOKEN`（不一致时 `/internal/agent/*` 401）；
> main 依赖 runtime 健康后才启动；runtime 只在容器网络内用 9990，不映射宿主端口。
> compose 已包含 `model-gateway` / `capability-gateway` / `common-capability` 与一次性 `migrate`；runtime 依赖 model-gateway 与 capability-gateway 健康，capability-gateway 依赖 worker 健康。
> `MODEL_INTERNAL_TOKEN`（runtime ↔ model-gateway）由 `x-app-env` 统一注入，默认 `${MODEL_INTERNAL_TOKEN:-local-dev-model-token}`；生产务必覆盖。
> compose 里的 `AGENT_INTERNAL_TOKEN` 默认取 `${AGENT_INTERNAL_TOKEN:-local-dev-internal-token}`，
> 与本地 `.env` 的 `dev-agent-internal` 不同；容器内以 compose 环境为准，两端共用锚点所以不会不一致。

> **admin 已加入 compose**：`docker-compose.yaml` 提供 postgres / redis / minio / migrate / main /
> agent-runtime / capability-gateway / common-capability / web / admin；admin 容器内 9845，宿主映射 9846 避开本地 dev。
> 也可单独构建部署：
> 开发端口 9845，生产走 `output: 'standalone'`，由 `apps/admin/scripts/start.sh` 以 `PORT=9845` 启动；
> `NEXT_PUBLIC_*` 在构建期内联，`SERVER_URL` 与 `SHARE_INTERNAL_SECRET` 在运行时读取。

### 镜像构建

```bash
# 先构建基础镜像（node 26.13.0 + pnpm 12.18.0 + 运维工具 bash/curl/wget/jq/tzdata）
./build-base-image.sh
# 等价于
docker build -t node26-pnpm12:1.0 -f docker/Dockerfile.base .

# 构建 main / agent-runtime / web 镜像
docker build -t billy-main:latest -f docker/Dockerfile.main .
docker build -t billy-agent-runtime:latest -f docker/Dockerfile.agent-runtime .
docker build -t billy-web:latest -f docker/Dockerfile.web .
```

### Kubernetes 部署

`k8s/` 目录提供 **main + agent-runtime** 的清单与部署说明（Deployment / Service / PDB / Ingress；
runtime 只有 Deployment + ClusterIP Service，不接公网 Ingress）：
滚动策略 `maxUnavailable: 0` + preStop + 三类探针分工（`/healthz` 存活、`/readyz` 就绪）+
`terminationGracePeriodSeconds` 覆盖优雅关闭期限，SSE 单独一份关缓冲的 Ingress。
字段取值来由、跨文件不变量（grace vs `SHUTDOWN_TIMEOUT_MS`+preStop、后端 keep-alive vs 网关上游空闲）、
上线验证步骤见 [k8s/README.md](../../k8s/README.md)。

### 特性

- **main / agent-runtime**：两个独立镜像，multi-stage + `pnpm deploy --prod` 提取运行时依赖，
  仅携带编译产物与生产依赖，非 root 用户运行；`lark-cli` 只装在 agent-runtime（飞书 CLI 连接器的
  执行方，版本由 `LARK_CLI_VERSION` 固定），main 镜像不装
- **web**：Next.js `output: 'standalone'` 模式，产物不携带源码与 devDependencies
- **基础镜像**：内置 `bash / curl / wget / jq / bind-tools / tzdata（Asia/Shanghai）` 等运维工具，
  并切换 npmmirror 镜像源

### 前置反向代理（Kong / Nginx / LB）

前面挂了网关时，有四处必须核对，否则会出现「查不到原因」的间歇性故障：

**1. keep-alive 复用竞态（间歇 502）**

Node 的 `server.keepAliveTimeout` 默认 **5s**，而 Kong 上游连接池默认
`upstream_keepalive_idle_timeout = 60s`，且它**不认**后端响应头里的 `Keep-Alive: timeout=N`
提示 —— 后端 5s 就关、网关认为 60s 内还能复用，于是网关在 **[5s, 60s] 窗口**里挑中一条正在
关闭的连接发请求 → 间歇性 `502 / upstream prematurely closed connection`。
**后端日志里查不到**（请求没到应用），很难定位。

本工程已默认 `keepAliveTimeout = 75s` / `headersTimeout = 80s`（>`KEEP_ALIVE_TIMEOUT_MS` 与
`HEADERS_TIMEOUT_MS` 可覆盖，见 `.env.example`）。规则：**每一跳里「服务端」的空闲超时必须大于
「客户端」的**，即从外到内递增，各留 5s 以上余量（LB 空闲 < Kong 客户端 keepalive；
Kong 上游空闲 60s < 后端 75s）。注意 `headersTimeout` 必须大于 `keepAliveTimeout`——
Node 对反序**不报错、静默接受**，故本项目在配置层用 `superRefine` 显式拦住（超了直接启动失败）。

**2. SSE 会被网关缓冲**

`POST /sse/subscribe` 是长连接流（默认 15s 心跳保活）；AI 对话的 `POST /agent/chat/stream`
（main 起流、runtime 经 Kafka 回写）与 `GET /agent/run/stream` 同样是长连接，网关规则一致。Kong 的 Route 属性
`response_buffering` 默认 `true`，会把响应缓冲后统一下发 → 流式失效 / 断续。
需在该路由（或 Service）上设 **`response_buffering = false`**；Service 的 `read_timeout`
（默认 60s）必须大于 SSE 心跳间隔。

**3. 限流与客户端 IP**

走网关必须把 `RATE_LIMIT_TRUST_PROXY=true`，否则限流按网关的 IP 计数（所有客户端共用一个
key、白名单失效）。

**4. 滚动更新时的优雅关闭（避免在途请求被切断）**

`SIGTERM` 后的关闭顺序：`beforeApplicationShutdown`（`StreamHub` 给每条 SSE 连接推
`stream.shutdown` 再关闭）→ `httpServer.close()`（停止接收新连接 + 等在途请求自然结束）→
各资源 `onApplicationShutdown`。**SSE 长连接必须先排空**：只要有一条存活，`server.close()`
的回调就永不触发、`app.close()` 挂死，只能等 `terminationGracePeriodSeconds` 到点被 SIGKILL，
在途请求跟着一起死（表现为滚动更新 502）。客户端收到 `stream.shutdown` 会立即重连到其他实例，
而不是把流的正常结束当成终态。

总期限由 `SHUTDOWN_TIMEOUT_MS` 控制（默认 25s），超时**强制退出并记 error 日志**——
与其卡死到被 SIGKILL（连原因都留不下），不如自己记录后退出。

k8s 侧配套：`terminationGracePeriodSeconds` 要大于 `SHUTDOWN_TIMEOUT_MS` + preStop 耗时；
preStop 先 `sleep` 数秒等 endpoint 摘除生效；探针指向 `GET /healthz`（liveness，不探依赖）与
`GET /readyz`（readiness，依赖不可用返 503 主动摘流），滚动策略用 `maxUnavailable: 0`。
