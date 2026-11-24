# 部署

> 本地依赖、环境变量、Docker 镜像、Kubernetes 与前置反向代理。
> 架构与配置链路见 [architecture.md](./architecture.md)。

## 环境变量

> 每个变量的默认值、必填性、按用途分组见 **[环境变量指南](./env.md)**；本节只讲部署相关口径。

**8 份配置文件**：六个 Nest 服务各有 `apps/<app>/.env`，两个前端各有 `apps/admin/.env` /
`apps/web/.env.local`。`pnpm bootstrap` 会生成全部 8 份（含 `model-gateway` 与 `workspace-service`，
库地址自动与 main 对齐）；跳过 bootstrap 时手动复制模板：

```bash
cp apps/model-gateway/.env.example apps/model-gateway/.env
cp apps/workspace-service/.env.example apps/workspace-service/.env
```

**覆盖顺序（很重要）**：6 个 Nest 服务的 `envConfigLoader` 用 `dotenv override: true` ——
**存在 `.env` 文件时，文件里的值会覆盖同名真实进程环境变量**，命令行前缀覆盖无效；容器 / k8s 里不挂
`.env`（`.dockerignore` 也排除 `**/.env`），所以编排层注入的环境变量生效。admin / web（Next）相反：
真实进程环境变量优先、`.env.local` 只补缺失键。

**端口**：服务专属键优先，`PORT` 是通用兼容键 —— main `PORT` 9989、agent-runtime `PORT` 9990、
model-gateway `MODEL_GATEWAY_PORT` 9992、capability-gateway `TOOL_GATEWAY_PORT` 9993、
common-capability `TOOL_WORKER_PORT` 9994、workspace-service `WORKSPACE_SERVICE_PORT` 9995；
容器 / k8s 统一写 `PORT`，端口必须与 Service `targetPort` 一致。

**必须跨服务对齐的值**（不一致会直接 401 / 403 / 登记不上）：

| 值 | 对齐范围 |
| --- | --- |
| `AGENT_INTERNAL_TOKEN` | main ↔ agent-runtime |
| `MODEL_INTERNAL_TOKEN`（网关校验） = `MODEL_GATEWAY_TOKEN`（调用侧携带） | model-gateway ↔ runtime / main |
| `TOOL_INTERNAL_TOKEN` | capability-gateway / common-capability 校验；runtime、main、workspace-service（登记）携带 |
| `WORKSPACE_INTERNAL_TOKEN` | workspace-service 校验；main、common-capability 携带 |
| `SHARE_INTERNAL_SECRET` | main ↔ admin（不配只关闭分享字节下发） |

生产必须替换所有 `dev-*` / `*-change-in-production` 默认值；compose 的 `x-app-env` 与 k8s 的共享 Secret
`billy-app` 就是用同一份值保证上面这些「必须相同」的令牌天然一致。

**后端寻址**（内网服务不进公网）：main 读 `AGENT_RUNTIME_URL` / `TOOL_GATEWAY_URL` /
`WORKSPACE_SERVICE_URL` / `MODEL_GATEWAY_URL`；runtime 读 `MODEL_GATEWAY_URL` / `TOOL_GATEWAY_URL`；
common-capability 读 `CAPABILITY_GATEWAY_URL` + `WORKSPACE_SERVICE_URL`；workspace-service 读
`WORKSPACE_GATEWAY_URL` + `WORKSPACE_SERVICE_ENDPOINT`（登记回调地址，容器 / 多机必须写成网关可达地址）。
不配这些地址时对应能力会跳过登记或回落到 `127.0.0.1`（Pod 内必然调不到）。

**可选能力**：对象存储 `OBJECT_STORAGE_*`（不配 endpoint = 未启用，服务照常启动）、Kafka
`KAFKA_BROKERS`（不配 = 不装配；当前无业务生产 / 消费方，AI 流式不依赖它）、飞书 `LARK_APP_*`
（不配通知通道降级）。各服务的完整必填 / 可选清单见 [env.md](./env.md)。

**前端**：`NEXT_PUBLIC_*` 在**构建期内联**（改完要重新 build），`SERVER_URL` 是**运行时**变量
（容器里指向内网 main）；`PORT` 只对 Next standalone 产物生效（dev 由 `next dev --port` 固定）。

## 构建与启动（生产）

```bash
# 全量构建（turbo，按依赖拓扑）；也可单独构建某个应用（会自动构建其依赖包）
pnpm build
# pnpm build:web / pnpm build:admin / pnpm build:main / pnpm build:runtime / pnpm build:model-gateway

# 其余单应用构建没有专用脚本，用 pnpm --filter 兜底
pnpm --filter @app/capability-gateway build
pnpm --filter @app/common-capability build
pnpm --filter @app/workspace-service build

# 分别启动（各自读自己的 .env；main 依赖 runtime 在 9990）
pnpm start:main                 # 公网 API / 控制面：9989
pnpm start:runtime              # agent loop：9990（只给 main 调，不要暴露到公网）
pnpm start:model-gateway        # 模型网关：9992
pnpm start:capability-gateway   # 能力网关：9993
pnpm start:common-capability    # 通用能力执行：9994
pnpm start:workspace-service    # 工作区执行面：9995
pnpm start:web                  # standalone，默认 9840
pnpm start:admin                # standalone，默认 9845

# 一次起全部 8 个应用（6 个 Nest 服务 + admin + web）
pnpm start:stack

# 或 Docker Compose（postgres + redis + minio + 6 服务 + migrate + web + admin）
pnpm docker:up

# 停止本地 start 起的进程（跨平台，默认 8 个端口：9840 / 9845 / 9989 / 9990 / 9992 / 9993 / 9994 / 9995）
pnpm kill:start
```

- admin / web 的 `start` 都是 `scripts/start-standalone.ts <app> <port>`（**不存在** `apps/admin/scripts/start.sh`）：
  它把 `.next/static` 与 `public` 拷进 standalone 产物再起 `server.js`，`PORT` 可覆盖默认端口。
- admin 构建前会跑 `scripts/copy-monaco.mjs`，把 Monaco 拷到 `public/monaco`（约 20MB，不进 git）。
- `dev:stack` 只起 6 个服务（不含 admin / web）；`start:stack` 才是 8 个应用全起。

> `lsof` 在某些情况下查不到监听进程（进程属于其它用户、容器端口转发、或没装 lsof）。
> `kill:start` 会用 TCP 连接探针独立判断端口是否真的在监听：查不到进程时明确报
> 「在监听但定位不到进程」并给出 `sudo lsof` / `netstat` / `docker ps` 排查命令，不会误报端口空闲。

## Docker

### Compose 服务（依赖一键起）

> 首次先做两件事：`./build-base-image.sh`（所有服务镜像都 `FROM node26-pnpm12:1.0`）、
> `pnpm bootstrap --skip-smoke`（生成八份 `.env`；compose 的 main / agent-runtime 用 `env_file`
> 挂载，缺文件会直接报错）。

```bash
docker compose up -d postgres redis minio   # 仅基础设施
docker compose up -d --build                # 全部（migrate + 6 服务 + admin + web + 依赖）
docker compose --profile kafka up -d        # 可选：追加 Kafka + 控制台
```

`docker-compose.yaml` 共 **15 个服务**：

| 服务               | 镜像 / 构建                        | 端口映射 / expose                          |
| ------------------ | ---------------------------------- | ------------------------------------------ |
| postgres           | `pgvector/pgvector:pg17`           | `15432:5432`（init-db.sql 只做库级设置，建表由迁移负责） |
| redis              | `redis:7-alpine`                   | `6380:6379`（AOF + `noeviction`）           |
| minio              | `minio/minio`                      | `19000:9000` / `19001:9001`                |
| main               | `docker/Dockerfile.main`           | `9989:9989`（公网入口）                     |
| agent-runtime      | `docker/Dockerfile.agent-runtime`  | `expose 9990`，**不映射宿主端口**           |
| migrate            | `docker/Dockerfile.agent-runtime`  | 一次性 Job，跑 `@repo/db` 迁移（`restart: 'no'`） |
| model-gateway      | `docker/Dockerfile.model-gateway`  | `expose 9992`                              |
| capability-gateway | `docker/Dockerfile.capability-gateway` | `expose 9993`                          |
| common-capability  | `docker/Dockerfile.common-capability`  | `expose 9994`                          |
| workspace-service  | `docker/Dockerfile.workspace-service`  | `expose 9995`                          |
| admin              | `docker/Dockerfile.admin`          | `9846:9845`（避开本机 dev 9845）            |
| web                | `docker/Dockerfile.web`            | `3001:3001`                                |
| kafka ¹            | `confluentinc/cp-kafka:7.4.8`      | `29092:29092`（容器内 `kafka:9092`）        |
| kafka-ui ¹         | `provectuslabs/kafka-ui`           | `8085:8080`                                |
| zookeeper ¹        | `confluentinc/cp-zookeeper:7.4.8`  | `22181:2181`                               |

¹ 这三个服务带 `profiles: ["kafka"]`，**不指定 profile 不会启动**。当前 Kafka 没有业务 topic 依赖，
只有确实要接异步消息时才起；启用后把 `KAFKA_BROKERS` 设为 `kafka:9092`（容器内）或
`127.0.0.1:29092`（宿主机直连）。

编排细节：

- **`x-app-env` 锚点**：main 与 agent-runtime 各自挂 `env_file`（`apps/*/.env`），并合并这份锚点；
  锚点统一注入 DB / Redis / JWT / 对象存储、`AGENT_COMMAND_WORK_DIR`，以及**四个内部 token 的全部键**：
  `AGENT_INTERNAL_TOKEN`、`MODEL_INTERNAL_TOKEN` + `MODEL_GATEWAY_TOKEN`、
  `TOOL_INTERNAL_TOKEN` + `TOOL_GATEWAY_TOKEN`、`WORKSPACE_INTERNAL_TOKEN`；
  同值由锚点保证，生产务必用环境变量覆盖默认值。
  model-gateway / capability-gateway / common-capability / workspace-service **只吃锚点 + 自己的 `environment`**，
  不挂 `env_file`（它们的 `.env` 只用于本机 `dev` / `start`）。
- **健康检查**：postgres（`pg_isready`）、redis（`ping`）、minio（health live），
  main / agent-runtime / model-gateway / capability-gateway / common-capability / workspace-service
  都探 `/healthz`（路径与端口按各服务）；admin / web 没有健康检查，只 `depends_on: main healthy`。
- **启动顺序**：`migrate` 成功后才起各业务服务；main 等 agent-runtime 健康；
  agent-runtime 等 model-gateway + capability-gateway 健康；capability-gateway 等 common-capability 健康。
- **卷**：`postgres-data`、`redis-data`、`minio-data`、`lark-cli-data`（runtime 的 `/home/appuser/.billy`），
  以及 `workspace-data` —— main / agent-runtime / common-capability 挂到 `/home/appuser/.billy-cli`，
  workspace-service 挂到 `/home/appuser/.billy/workspaces`（local 后端根）。
- **workspace-service** 额外挂 `/var/run/docker.sock`（容器后端要真起工作区容器），
  并设 `WORKSPACE_CONTAINER_RUNTIME` / `WORKSPACE_DEFAULT_IMAGE` / `WORKSPACE_LOCAL_ROOT`；
  本地一键起时 `AGENT_WORKSPACE_SANDBOX=false` 仅联调，生产按宿主能力设 `enforce`。

MinIO 在 compose 里默认随 `docker compose up` 启动，但对象存储本身是可选能力：
不用上传 / 附件 / 分享时可以不启它（`docker compose up -d postgres redis main agent-runtime web`），
服务照常运行，只是存储相关接口报「未配置或不可用」。

> admin 容器内 9845、宿主 9846，避开本地 dev；`NEXT_PUBLIC_*` 在构建期内联，
> `SERVER_URL` 与 `SHARE_INTERNAL_SECRET` 在运行时读取。

### 镜像构建

`docker/` 下共 **10 个 Dockerfile**：

| 文件                             | 产物 |
| -------------------------------- | ---- |
| `Dockerfile.base`                | 基础镜像 `node26-pnpm12:1.0`（node 26.13.0-alpine + pnpm 12.18.0 + 运维工具） |
| `Dockerfile.main`                | main（公网 API / 控制面） |
| `Dockerfile.agent-runtime`       | agent-runtime（同时被 `migrate` 复用） |
| `Dockerfile.model-gateway`       | 模型网关 |
| `Dockerfile.capability-gateway`  | 能力网关 |
| `Dockerfile.common-capability`   | 通用能力执行 |
| `Dockerfile.workspace-service`   | 工作区执行面服务 |
| `Dockerfile.web`                 | web 前台 |
| `Dockerfile.admin`               | admin 后台 |
| `Dockerfile.workspace-image`     | **被管工作区镜像**（跑 AI 命令的容器，不是服务） |

```bash
# 先构建基础镜像（node 26.13.0 + pnpm 12.18.0 + bash/curl/wget/jq/bind-tools/tzdata，TZ Asia/Shanghai）
./build-base-image.sh
# 等价于
docker build -t node26-pnpm12:1.0 -f docker/Dockerfile.base .

# 六个服务镜像
docker build -t billy-main:latest -f docker/Dockerfile.main .
docker build -t billy-agent-runtime:latest -f docker/Dockerfile.agent-runtime .
docker build -t billy-model-gateway:latest -f docker/Dockerfile.model-gateway .
docker build -t billy-capability-gateway:latest -f docker/Dockerfile.capability-gateway .
docker build -t billy-common-capability:latest -f docker/Dockerfile.common-capability .
docker build -t billy-workspace-service:latest -f docker/Dockerfile.workspace-service .

# 两个前端
docker build -t billy-web:latest -f docker/Dockerfile.web .
docker build -t billy-admin:latest -f docker/Dockerfile.admin .

# 被管工作区镜像：python 3.13-slim + node 26 + pnpm，工作目录 /workspace
# tag 约定 billy-workspace:<版本>，默认值与 workspace-service 的 WORKSPACE_DEFAULT_IMAGE 对齐
docker build -f docker/Dockerfile.workspace-image -t billy-workspace:2026.11.1 docker
```

### Kubernetes 部署

`k8s/` 目录提供 **25 个 YAML 清单**（另有说明文档 README），覆盖 **6 个 Deployment**：

- main（3 副本）、agent-runtime（2 副本）、model-gateway（2 副本）、capability-gateway（2 副本）、
  common-capability（1 副本，本地工作区不共享）、workspace-service（**2 副本**：跨副本
  lifecycle / exec / fs 锁与 lastUsed 走 Redis；Docker 跨宿主 / local 仍只允许单副本）。
- **PVC / RBAC**：`15-pvc-agent-runtime-workspaces.yaml` 是 agent-runtime 的会话工作区卷（RWX、20Gi、
  `storageClassName` 需按集群替换）；`16-rbac-workspace-service.yaml` 给 workspace-service 配
  ServiceAccount / Role / RoleBinding（Role 只授 pods 的 get/list/watch/create/delete 与 `pods/exec`，
  不授其它资源；它自己**不挂业务 PVC**：k8s 后端下工作区就是一个带 `app=billy-workspace` 标签的
  `sleep infinity` Pod，`/workspace` 用 `emptyDir`）。
- **ConfigMap 分组**（共 7 份）：`10-configmap.yaml` 里放 `billy-shared`（共用：`NODE_ENV` / 对象存储 / 日志）、
  `billy-main`、`billy-agent-runtime`；四个内网服务各一份专属 ConfigMap（`11`–`14`：
  model-gateway / capability-gateway / common-capability / workspace-service）。
  敏感值统一放 Secret `billy-app`，所有 Deployment 共用一份，`envFrom` 顺序是
  `billy-shared → 各自 ConfigMap → billy-app`（键不重复）。
- **Service**：6 个 ClusterIP（main `80 → http(9989)`，其余各自端口名 `http`）。
- **HPA**：main 3–8、agent-runtime 2–8、model-gateway 2–8，按 CPU 70%（按 requests 算）；
  需要 metrics-server，否则一直停在 `minReplicas`。runtime 的 8 副本依赖工作区 PVC 是 RWX。
- **PDB**：只有 main（`minAvailable: 2`）；它约束节点排水 / 驱逐，不约束滚动更新。
- **Ingress**：两份 —— 常规入口 `api.example.com`，以及 SSE 专用一份（`/sse`、`/agent/chat/stream`、
  `/agent/run`，`proxy-buffering: off` + 放大读写超时）；ingress-nginx 按最长路径优先合并。
- **滚动更新**：`maxUnavailable: 0` + `maxSurge: 1` + preStop `sleep 8` + 三类探针分工
  （`/healthz` 存活、`/readyz` 就绪）+ `terminationGracePeriodSeconds: 60`。

跨文件不变量（改任意一个都要连带核对）：

| 不变量 | 原因 |
| ------ | ---- |
| `SHUTDOWN_TIMEOUT_MS`(25s) + preStop(8s) **<** `terminationGracePeriodSeconds`(60s) | 否则排空没走完就被 SIGKILL，在途请求照样被切断 |
| 后端 `KEEP_ALIVE_TIMEOUT_MS`(75s) **>** 网关上游空闲超时（ingress-nginx 默认 60s） | 后端先关空闲连接 → 网关往死 socket 发请求 → 无痕 502 |
| `HEADERS_TIMEOUT_MS`(80s) **>** `KEEP_ALIVE_TIMEOUT_MS`(75s) | Node 静默接受反序，故在配置层显式拦 |
| `readinessProbe` → `/readyz`，`livenessProbe` / `startupProbe` → `/healthz` | liveness 探外部依赖会在依赖抖动时重启全部 Pod |
| 四个内部 token 在「校验方 / 携带方」两侧同值（`MODEL_INTERNAL_TOKEN` = `MODEL_GATEWAY_TOKEN`） | 否则对应内部接口一律 401 |
| 工作区 PVC 挂载路径 = `AGENT_COMMAND_WORK_DIR`（`/home/appuser/.billy/workspaces`） | 不一致时持久化等于没做 |
| `APP_VERSION` = 对应服务的镜像 tag | 滚动更新后用 `GET /info` 核对线上实际构建 |
| `replicas` / HPA `minReplicas`(3) > `minAvailable`(2) ≥ 1 | PDB 需留出可驱逐余量，否则节点排水会挂住 |

部署顺序：namespace → Secret（含内部 token）→ ConfigMap / PVC → Deployment（先跑迁移）→ Service →
PDB / HPA → Ingress。字段取值来由、Secret 键清单与上线验证步骤见 [k8s/README.md](../../k8s/README.md)。

### 特性

- **main / agent-runtime / model-gateway / capability-gateway / common-capability / workspace-service**：
  六个独立镜像，multi-stage + `pnpm deploy --prod` 提取运行时依赖，仅携带编译产物与生产依赖，
  非 root 用户（`appuser`）运行
- **web / admin**：Next.js `output: 'standalone'` 模式，产物不携带源码与 devDependencies
- **基础镜像**：内置 `bash / curl / wget / busybox-extras / jq / bind-tools / tzdata（Asia/Shanghai）` 等运维工具，
  并切换 npmmirror 镜像源
- **workspace-image**：被管工作区镜像与执行面服务镜像不是一回事 —— 前者只提供 shell / python / node / git，
  由 workspace-service 按需起容器；镜像内是 root（`apt-get install` 要用），隔离靠容器边界

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

流式路径有三类：`POST /sse/subscribe`（业务 SSE，默认 15s 心跳保活）、
`POST /agent/chat/stream`（AI 对话：main 起流，runtime 把输出发到 Redis pub/sub 频道，
main 的 `AgentSseBridge` 订阅后写 SSE —— **不经 Kafka**）、以及断线重连用的
`GET /agent/run/stream`。它们都是长连接，网关规则一致：Kong 的 Route 属性
`response_buffering` 默认 `true`，会把响应缓冲后统一下发 → 流式失效 / 断续。
需在该路由（或 Service）上设 **`response_buffering = false`**；Service 的 `read_timeout`
（默认 60s）必须大于 SSE 心跳间隔。k8s 侧对应 `51-ingress-sse.yaml` 的 `proxy-buffering: off`。

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
