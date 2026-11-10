# 部署

> 本地依赖、环境变量、Docker 镜像、Kubernetes 与前置反向代理。
> 架构与配置链路见 [architecture.md](./architecture.md)。

## 环境变量（手动）

`pnpm bootstrap` 会自动从模板生成，也可手动复制：

```bash
cp apps/server/.env.example apps/server/.env
cp apps/admin/.env.example apps/admin/.env
cp apps/web/.env.local.example apps/web/.env.local
```

`apps/server/.env` 关键项（完整模板见 `apps/server/.env.example`）：

```env
PORT=9989
DB_URL=postgresql://root:pg1234@localhost:5432/billy-cli   # 默认端口 5432；compose 映射 15432
REDIS_URL=redis://localhost:6379/0                          # 默认端口 6379；compose 映射 6380
JWT_SECRET=dev-secret-change-in-production                  # 生产务必替换
AUTH_ENABLED=true                                           # false 关闭鉴权（clone 自用）
OBJECT_STORAGE_ENDPOINT=http://localhost:9000               # 默认端口 9000；compose 映射 19000
```

`OBJECT_STORAGE_ENDPOINT` **可以不配**：对象存储是可选能力，未配置或 MinIO / S3 不可达时服务照常启动，
只有上传 / 下载 / 附件读取等真正用到存储的接口才报「对象存储未配置或不可用」。

`apps/web/.env.local` 与 `apps/admin/.env` 使用默认值即可（不配置时代码有默认值兜底）。

## 构建与启动（生产）

```bash
# 全量构建（turbo，按依赖拓扑）
pnpm build

# 分别启动
pnpm start:server
pnpm start:web

# 或 Docker Compose（postgres + redis + minio + server + web）
pnpm docker:up
```

## Docker

### Compose 服务（依赖一键起）

```bash
docker compose up -d postgres redis minio   # 仅基础设施
pnpm docker:up                              # 全部（含 server + web）
docker compose --profile kafka up -d        # 追加 Kafka + 控制台（可选，默认不启动）
```

| 服务     | 镜像 / 构建             | 端口映射                    |
| -------- | ----------------------- | --------------------------- |
| postgres | postgres:17-alpine      | `15432:5432`（init-db.sql 只做库级设置，建表由迁移负责）|
| redis    | redis:7-alpine          | `6380:6379`                 |
| minio    | minio/minio             | `19000:9000` / `19001:9001` |
| server   | docker/Dockerfile.server| `9989:9989`                 |
| web      | docker/Dockerfile.web   | `3001:3001`                 |
| kafka  ¹ | confluentinc/cp-kafka:7.4.8 | `29092:29092`            |
| kafka-ui ¹ | provectuslabs/kafka-ui | `8085:8080`               |
| zookeeper ¹ | confluentinc/cp-zookeeper:7.4.8 | `22181:2181`      |

¹ 这三个服务带 `profiles: ["kafka"]`，**不指定 profile 不会启动**。启用后把服务端
`KAFKA_BROKERS` 设为 `kafka:9092`（容器内）或 `127.0.0.1:29092`（宿主机直连）；
不配置 `KAFKA_BROKERS` 时 `KafkaModule` 根本不装配，不影响其它功能。

### 镜像构建

```bash
# 先构建基础镜像（node 26.13.0 + pnpm 12.18.0 + 运维工具 bash/curl/wget/jq/tzdata）
./build-base-image.sh
# 等价于
docker build -t node26-pnpm12:1.0 -f docker/Dockerfile.base .

# 构建 server / web 镜像
docker build -t billy-server:latest -f docker/Dockerfile.server .
docker build -t billy-web:latest -f docker/Dockerfile.web .
```

### Kubernetes 部署

`k8s/` 目录提供 **server** 的清单与部署说明（Deployment / Service / PDB / Ingress）：
滚动策略 `maxUnavailable: 0` + preStop + 三类探针分工（`/healthz` 存活、`/readyz` 就绪）+
`terminationGracePeriodSeconds` 覆盖优雅关闭期限，SSE 单独一份关缓冲的 Ingress。
字段取值来由、跨文件不变量（grace vs `SHUTDOWN_TIMEOUT_MS`+preStop、后端 keep-alive vs 网关上游空闲）、
上线验证步骤见 [k8s/README.md](../../k8s/README.md)。

### 特性

- **server**：multi-stage + `pnpm deploy --prod` 提取运行时依赖，仅携带编译产物与生产依赖，
  非 root 用户运行；预装官方 `lark-cli`（飞书 CLI 连接器用，版本由 `LARK_CLI_VERSION` 固定）
- **web**：Next.js `output: 'standalone'` 模式，产物不携带源码与 devDependencies
- **基础镜像**：内置 `bash / curl / wget / jq / bind-tools / tzdata（Asia/Shanghai）` 等运维工具，
  并切换 npmmirror 镜像源

### 前置反向代理（Kong / Nginx / LB）

前面挂了网关时，有三处必须核对，否则会出现「查不到原因」的间歇性故障：

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

`POST /sse/subscribe` 是长连接流（默认 15s 心跳保活）。Kong 的 Route 属性
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
