# 环境变量（按服务）

> 8 个 app 各自的环境变量**唯一详细说明**：模板、默认值（以 zod schema 为准）、必填口径、
> 构建期内联 / 运行时读取、以及本次清理掉的死键。
> 部署侧口径（Docker / k8s / 前置代理）见 [deployment.md](./deployment.md)；
> 装配关系与端口拓扑见 [architecture.md](./architecture.md)。

## 总览

### 8 个 app 与配置文件

`bootstrap` 只生成 6 份（main / agent-runtime / capability-gateway / common-capability / admin / web），
**model-gateway 与 workspace-service 需要手动复制模板**：

```bash
cp apps/model-gateway/.env.example apps/model-gateway/.env
cp apps/workspace-service/.env.example apps/workspace-service/.env
```

| app | 包名 | 模板 | 本地文件 | 端口（默认） | 对外 |
| --- | --- | --- | --- | --- | --- |
| main | `@app/main` | `apps/main/.env.example` | `apps/main/.env` | 9989 | 公网 |
| agent-runtime | `@app/agent-runtime` | `apps/agent-runtime/.env.example` | `apps/agent-runtime/.env` | 9990（schema 默认 9989，**必须显式设置**） | 仅内网 / 只给 main 调 |
| model-gateway | `@app/model-gateway` | `apps/model-gateway/.env.example` | `apps/model-gateway/.env` | 9992 | 仅内网 |
| capability-gateway | `@app/capability-gateway` | `apps/capability-gateway/.env.example` | `apps/capability-gateway/.env` | 9993 | 仅内网 |
| common-capability | `@app/common-capability` | `apps/common-capability/.env.example` | `apps/common-capability/.env` | 9994 | 仅内网 |
| workspace-service | `@app/workspace-service` | `apps/workspace-service/.env.example` | `apps/workspace-service/.env` | 9995 | 仅内网 |
| admin | `@app/admin` | `apps/admin/.env.example` | `apps/admin/.env` | dev 9845（容器内 9845） | 公网 |
| web | `@app/web` | `apps/web/.env.local.example` | `apps/web/.env.local` | dev 9840（容器内 3001） | 公网 |

> `9991` 未使用。前端只连 main；四个内网服务不要暴露到公网。

### 加载链路

6 个 Nest 服务的链路一致：

1. 入口 `src/main.ts` 第一行 `await loadXxxAppConfig()`（**在 `NestFactory.create` 之前**）；
2. `loadXxxAppConfig()` → `AppConfigFacade.initial({ schema, loader: envConfigLoader(...) })`；
3. `envConfigLoader`：若 `process.cwd()` 下存在 `.env` 文件，用 `dotenv` 加载它，然后 `mapXxxEnv(process.env)`
   把扁平的变量名映射成嵌套 shape（未设置的键留 `undefined`）；
4. `AppConfigFacade` 先 `mergeSchemaDefaults(raw, schema)` 把 schema 声明的**嵌套对象默认值**物化出来，
   再交给 zod `parse()`：校验 + 补默认值 + 缓存（重复调用返回同一份）；
5. `AppConfigModule.forRoot()` 把已加载配置接进 `@nestjs/config`，之后各模块 `forRootAsync` 惰性读
   `ConfigService.get('<namespace>')`。每个 app 只声明自己消费的分片（main 15 / runtime 12，见
   [backend.md](./backend.md) 的「配置链路」），比如 main 没有 `agent` 分片、runtime 没有
   `jwt` / `password` / `share` / `aiModel` 分片。

失败口径：来源加载失败抛 `ConfigLoadError`，zod 校验失败抛 `ConfigValidationError`（附字段路径），
两者都发生在监听端口之前 → **配置错直接起不来**。

#### 关键事实：`.env` 与真实进程环境变量谁优先

**以代码为准**（`packages/kits/src/foundation/config/loaders/index.ts` 的
`loadDotenv({ path, override: true })`，dotenv 18.0.9）：

- 6 个 Nest 服务：**`.env` 文件存在时，文件里的值会覆盖同名真实进程环境变量**（`override: true`）。
  也就是说 `PORT=1234 pnpm dev:main` 这种临时覆盖**会被 `apps/main/.env` 里的 `PORT` 盖掉**。
  容器里不放 `.env`（Dockerfile 只拷构建产物，`.dockerignore` 也排除了 `**/.env`），
  所以容器 / k8s / CI 里真实环境变量生效。
- admin / web（Next.js）：由 `@next/env` 自己加载 `.env.local` / `.env`，规则相反 ——
  **真实进程环境变量优先于 `.env` 文件**（`processEnv()` 只补进程环境里没有的键），
  同一键在 `.env.local` 里优先于 `.env`。

> 结论：**容器部署永远走编排层环境变量；本机开发优先认 `.env` 文件**。要临时改值，改 `.env`；
> 不要指望命令行前缀覆盖，也不要把 `.env` 塞进镜像。

#### 端口别名优先级

main / agent-runtime 只认 `PORT`。其余四个内网服务各有一个**兼容别名，别名 > `PORT`**：

| 服务 | 端口变量 |
| --- | --- |
| model-gateway | `MODEL_GATEWAY_PORT` > `PORT` |
| capability-gateway | `TOOL_GATEWAY_PORT` > `PORT` |
| common-capability | `TOOL_WORKER_PORT` > `PORT` |
| workspace-service | `WORKSPACE_SERVICE_PORT` > `PORT` |

模板只写 `PORT`；别名是给 compose / k8s / 旧 `.env` 兼容用的（空串视为未设置）。

#### 可选模块

- **Kafka**：只有配置了 `KAFKA_BROKERS` 才装配 `KafkaModule`（main / agent-runtime）。当前没有业务
  生产 / 消费方，AI 流式走 Redis pub/sub；不配 = 完全不装配。
- **Lark（飞书）**：`LARK_APP_ID` + `LARK_APP_SECRET` 都配置才装配 `LarkClient`；通知通道还需
  `LARK_NOTIFY_RECEIVE_ID`，否则通道降级为「未配置」。
- **对象存储**：`OBJECT_STORAGE_ENDPOINT` 不配 = 未启用，服务照常启动，只有真正用到存储的接口报
  「未配置或不可用」；`OBJECT_STORAGE_PROVIDER` 取 `s3`（含 MinIO）或 `cos`。
- **邮件通知**：`ALERT_SMTP_HOST` 不配则邮件通道不可用（不影响启动）。

#### `pnpm bootstrap` 会做什么、不会做什么

`scripts/setup.ts`：

- 生成上面那 **6 份** `.env`（已存在则保留原配置，不覆盖）；
- 只对**本次新建**的文件做地址对齐：检测到 compose 宿主端口（15432 / 6380 / 19000）而本机端口
  （5432 / 6379 / 9000）未开时，把 main / agent-runtime / capability-gateway / common-capability
  里的 DB / Redis / MinIO 地址改成映射端口；admin / web 只替换 MinIO 地址；
- **不会**生成 model-gateway / workspace-service 的 `.env`，也不会改已存在的 `.env`。

#### k8s / compose 的覆盖口径

- **docker compose**：`x-app-env` 锚点整份注入（DB / Redis / JWT / 对象存储 / `AGENT_COMMAND_WORK_DIR` /
  四组内部 token / `KAFKA_BROKERS`），main 与 agent-runtime 额外挂 `env_file: apps/*/.env`，
  各服务再在 `environment` 里覆盖自己的端口与 URL；admin / web 只注入运行时 `SERVER_URL`。
- **k8s**：非敏感项走 ConfigMap（`billy-shared` + 各服务专属），敏感项（DB / Redis / JWT / 对象存储密钥 /
  内部 token）走 Secret `billy-app`，`envFrom` 顺序是 `billy-shared → 各自 ConfigMap → billy-app`。
  详见 [k8s/README.md](../../k8s/README.md)。

### 「必填」列的口径

本期文档统一用下面几种取值：

| 取值 | 含义 |
| --- | --- |
| 必填 | 不配会落到本地默认（容器 / 多机必然连错）或调用链直接 401，生产必须显式给 |
| 生产必改 | 有本地开发默认值，但生产必须换掉 |
| 可选 | 有安全默认值，一般不用动 |
| 不配=未启用 | 空 = 对应能力 / 模块关闭，服务照常启动 |
| 仅 seed:admin | 只被 `pnpm seed:admin` 脚本读取，不参与运行时 |
| 构建期 | Next 在 `next build` 时替换，运行时改无效 |

---

## main

公网 BFF：控制面业务 + 全部管理 HTTP + `/agent/*` 转发；不跑 agent loop，模型调用统一经 model-gateway。
配置：`apps/main/.env.example` → `apps/main/.env`；端口 **9989**。

### 运行 / 端口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | `9989` | HTTP 监听端口；前端 / compose / k8s 都按它寻址 | 可选 |
| `KEEP_ALIVE_TIMEOUT_MS` | `75000` | Node `server.keepAliveTimeout`；必须大于前置网关的上游空闲超时（ingress-nginx 默认 60s） | 可选 |
| `HEADERS_TIMEOUT_MS` | `80000` | 收完请求头的上限；**必须大于** `KEEP_ALIVE_TIMEOUT_MS`，否则启动即报错 | 可选 |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | 优雅关闭总期限；必须小于 k8s `terminationGracePeriodSeconds` - preStop | 可选 |
| `APP_VERSION` | `dev` | 部署版本标识，`GET /info` 可核对线上构建；生产建议=镜像 tag | 可选 |

### 数据库 / Redis

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `DB_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | PostgreSQL 连接串；模板给本地开发串 `postgresql://root:pg1234@localhost:5432/billy-cli` | 必填 |
| `DB_SYNC` | `false` | TypeORM 自动建表；生产必须 false（走迁移） | 可选 |
| `DB_POOL_SIZE` | `10` | 每实例连接池大小（上限 100） | 可选 |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis 连接串；启动即连接（不可用则起不来） | 必填 |
| `REDIS_KEY_PREFIX` | 空 | key 前缀，空 = 不加前缀 | 可选 |

### 鉴权 / 账号

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AUTH_ENABLED` | `true` | `false` 同时关闭前台用户 + 后台管理员两套鉴权（仅自托管单租户） | 可选 |
| `JWT_SECRET` | `default-secret-change-in-production` | JWT 签名密钥 | 生产必改 |
| `JWT_EXPIRES_IN` | `7d` | JWT 有效期 | 可选 |
| `PASSWORD_HASH_ROUNDS` | `10` | bcrypt 轮数 | 可选 |
| `RESET_PASSWORD_TOKEN_TTL_MINUTES` | `30` | 找回密码 token 有效期（分钟） | 可选 |
| `WEB_URL` | `http://localhost:9840` | 前台站点地址；找回密码邮件里的重置链接用它拼 | 生产必改 |
| `RATE_LIMIT_WHITELIST` | 空 | 精确 IP / IPv4 CIDR 白名单，逗号分隔 | 可选 |
| `RATE_LIMIT_TRUST_PROXY` | `false` | 是否信任 `x-forwarded-for`；部署在反代 / Ingress 之后必须置 `true` | 生产必改 |

### 对象存储

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `OBJECT_STORAGE_PROVIDER` | `s3` | `s3`（含 MinIO）或 `cos` | 可选 |
| `OBJECT_STORAGE_REGION` | `us-east-1` | 区域 | 可选 |
| `OBJECT_STORAGE_BUCKET` | `billy-cli` | 桶名 | 可选 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | `minioadmin` | 访问密钥 | 生产必改 |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | `minioadmin` | 私有密钥 | 生产必改 |
| `OBJECT_STORAGE_ENDPOINT` | 空 | S3 / MinIO 端点；**不配 = 对象存储未启用** | 不配=未启用 |

### 日志

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` | 可选 |
| `LOKI_HOST` | 空 | Loki 地址（模板里注释掉）；不配只输出到 stdout。main 的 logger 前缀固定 `server` | 不配=未启用 |

### 监控告警

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `ALERT_ENABLED` | `true` | 告警总开关；`false` 时 ingestError 直接跳过 | 可选 |
| `ALERT_EMAIL_TO` | 空 | 告警邮件默认接收人（email 通道的 to） | 可选 |
| `MONITOR_INSTANCE_ID` | 空 | 实例标识；缺省用 `hostname:pid` | 可选 |
| `MONITOR_SAMPLE_RETENTION_DAYS` | `30` | 指标样本保留天数 | 可选 |

### 通知通道（邮件 / 飞书）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `ALERT_SMTP_HOST` | 空 | SMTP 主机；不配则邮件通道不可用 | 不配=未启用 |
| `ALERT_SMTP_PORT` | `465` | SMTP 端口 | 可选 |
| `ALERT_SMTP_SECURE` | `true` | 是否 TLS | 可选 |
| `ALERT_SMTP_USER` | 空 | SMTP 用户名 | 可选 |
| `ALERT_SMTP_PASS` | 空 | SMTP 密码 | 可选 |
| `ALERT_SMTP_FROM` | 空 | 发件人（配了邮件通道就必须填） | 可选 |
| `LARK_NOTIFY_RECEIVE_ID` | 空 | 飞书通知接收人 id；不配则飞书通知通道不装配 | 不配=未启用 |
| `LARK_NOTIFY_RECEIVE_ID_TYPE` | `open_id` | `open_id` / `chat_id` / `union_id` / `user_id` / `email` | 可选 |
| `LARK_APP_ID` | 空 | 飞书应用 App ID（与 SECRET 成对配置才装配 `LarkClient`） | 不配=未启用 |
| `LARK_APP_SECRET` | 空 | 飞书应用 App Secret | 不配=未启用 |
| `LARK_DOMAIN` | `feishu` | `feishu`（国内）/ `lark`（国际） | 可选 |

### 内部服务寻址 / 令牌

main 在这里只做**携带方**（调下游时带 `x-internal-token`）；校验方是 runtime / model-gateway /
capability-gateway / workspace-service，两侧令牌必须同值。下列寻址键都是**直接读 `process.env`**，
不进 app-config（`MODEL_GATEWAY_*` 例外，走 `modelGateway` 分片）。

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_RUNTIME_URL` | `http://127.0.0.1:9990` | main → agent-runtime（`/agent/*` 转发、SSE、目录查询） | 必填 |
| `AGENT_INTERNAL_TOKEN` | 空 | runtime 校验的令牌；空 = 所有内部请求 401 | 必填 |
| `TOOL_GATEWAY_URL` | `http://127.0.0.1:9993` | main → capability-gateway（后台能力 / 工具配置页取目录） | 必填 |
| `TOOL_GATEWAY_TOKEN` | 空 | 调网关时携带的令牌；空则回落 `TOOL_INTERNAL_TOKEN`，再空回落字面量 `dev-tool-token` | 可选 |
| `TOOL_INTERNAL_TOKEN` | 空 | 模板给本地值 `dev-tool-token`；必须与 capability-gateway 同值 | 生产必改 |
| `WORKSPACE_SERVICE_URL` | `http://127.0.0.1:9995` | main → workspace-service（文件页 / 工作区控制） | 必填 |
| `WORKSPACE_INTERNAL_TOKEN` | 空 | 空则回落 `TOOL_INTERNAL_TOKEN`，再空回落 `dev-workspace-token`；必须与 workspace-service 同值 | 生产必改 |
| `MODEL_GATEWAY_URL` | `http://127.0.0.1:9992` | main → model-gateway（后台模型明细同步 / 连通性测试） | 必填 |
| `MODEL_GATEWAY_TOKEN` | 空 | 携带给 model-gateway 的令牌；必须与网关的 `MODEL_INTERNAL_TOKEN` 同值 | 必填 |
| `MODEL_GATEWAY_TIMEOUT_MS` | `60000` | 调模型网关超时（ms） | 可选 |

### AI 首次种子

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_SEED_FROM_ENV` | `true` | 是否允许用 `MASTRA_*` 做首次供应商 / 模型种子；库里已有供应商就什么都不做 | 可选 |
| `MASTRA_MODEL` | 空 | 种子模型引用（`deepseek/deepseek-chat`），`modelKey` 取 `/` 之后部分；不配不种子 | 不配=未启用 |
| `MASTRA_API_KEY` | 空 | 种子供应商密钥；与 `MASTRA_MODEL` 成对才生效 | 不配=未启用 |
| `MASTRA_BASE_URL` | 空 | 供应商 baseUrl；空 = 不写 | 可选 |

### 工作区边界

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_WORKSPACE_MODE` | `enforce` | 沙箱不可用时 fail closed；仅自托管单租户可 `off` | 可选 |
| `AGENT_WORKSPACE_SANDBOX_NETWORK` | `deny` | 沙箱联网策略 `allow` / `deny` | 可选 |
| `AGENT_WORKSPACE_PROBE_TIMEOUT_MS` | `2000` | 沙箱探测超时（ms） | 可选 |
| `AGENT_COMMAND_WORK_DIR` | 空 | 会话工作区根；空则回落 `~/.billy/workspaces`。容器 / k8s 里必须与挂载路径一致 | 可选 |

### 文件免授权分享

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `SHARE_INTERNAL_SECRET` | 空 | 与 admin 的 `SHARE_INTERNAL_SECRET` 同值；空 = 分享字节下发一律 404 | 不配=未启用 |

### 可选：Kafka

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `KAFKA_BROKERS` | 空 | broker 列表（逗号分隔）；空 = 不装配 `KafkaModule` | 不配=未启用 |
| `KAFKA_CLIENT_ID` | `app` | 客户端标识 | 可选 |
| `KAFKA_TOPIC_PREFIX` | `app` | topic 前缀 | 可选 |
| `KAFKA_GROUP_ID_PREFIX` | `app` | 消费组前缀 | 可选 |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `3000` | 建连超时（快失败） | 可选 |
| `KAFKA_REQUEST_TIMEOUT_MS` | `15000` | 单次请求超时 | 可选 |
| `KAFKA_RETRY_COUNT` | `2` | 内部重试次数 | 可选 |
| `KAFKA_RETRY_INITIAL_DELAY_MS` | `300` | 重试初始间隔 | 可选 |
| `KAFKA_UNAVAILABLE_COOLDOWN_MS` | `5000` | 建连失败后的冷却期（0 = 关闭） | 可选 |

### 可选：技能链接导入

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | 空 | GitHub API token，仅导入私有仓库 / 提高限流额度时需要；读取时兼容 `GH_TOKEN` | 不配=未启用 |

### 首个管理员（仅 `pnpm seed:admin`）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `ADMIN_EMAIL` | `admin@billy.local` | 首个管理员邮箱 | 仅 seed:admin |
| `ADMIN_PASSWORD` | `admin123` | 首个管理员密码（首次登录后尽快改） | 仅 seed:admin |
| `ADMIN_REAL_NAME` | `超级管理员` | 首个管理员显示名 | 仅 seed:admin |

`seed:admin` 建出来的是**超级管理员**（`admins.type='god'`）：邮箱已存在时只把类型升为 `god`、
不覆盖密码，因此超管被误删后可以用同一条命令恢复。

### 个人凭据加密（`personal_credentials`）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PERSONAL_CREDENTIAL_KEY` | 空 | 主密钥简写：32 字节 base64（等价于 `v1:<base64>`） | 二选一 |
| `PERSONAL_CREDENTIAL_KEYS` | 空 | 多把密钥：`v1:<base64>,v2:<base64>`，用于轮换期间新旧共存 | 二选一 |
| `PERSONAL_CREDENTIAL_KEY_CURRENT` | `v1` | **写入**用哪一把；解密永远按密文自带的 keyId | 可选 |

生成本地密钥：`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`。
凭据解析接口 `POST /internal/credentials/resolve` 用 `TOOL_INTERNAL_TOKEN` 鉴权（与网关 / 执行面同值），
不单独引入新令牌。
配了但长度不对会**拒绝启动**（长度错等于强度错）；一把都没配则允许启动，但凭据写入会明确报错。
生产必须配，且放 Secret（不要放 ConfigMap）。

### 超管种子（启动期，见 `AdminSeedService`）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `ADMIN_SEED_FROM_ENV` | `true` | 是否允许用 `GOD_ADMIN_*` 做启动期超管种子 | 可选 |
| `GOD_ADMIN_EMAIL` | 空 | 首个超管邮箱；与密码成对才生效 | 不配=不种子 |
| `GOD_ADMIN_PASSWORD` | 空 | 首个超管密码（≥6 位，不达标则跳过并告警） | 不配=不种子 |

触发条件：开关为真、两个变量都非空、库里**没有存活超管**；若曾经有超管但已被删（含软删计数 > 0），
只打告警不自动重建（避免覆盖运维意图，恢复走 `pnpm seed:admin`）。失败不阻塞启动。
生产环境放 Secret，不要放 ConfigMap。

---

## agent-runtime

agent loop 执行侧：会话编排 / 工具面 / 上下文 / 技能 / 子 agent / 崩溃恢复；只给 main 调。
配置：`apps/agent-runtime/.env.example` → `apps/agent-runtime/.env`；端口 **9990**（schema 默认 9989，必须显式设置）。

### 运行 / 端口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | `9989`（schema）/ 模板 `9990` | **必须显式写 9990** 且与 main 的 `AGENT_RUNTIME_URL` 一致 | 必填 |
| `KEEP_ALIVE_TIMEOUT_MS` | `75000` | 同 main | 可选 |
| `HEADERS_TIMEOUT_MS` | `80000` | 必须大于 `KEEP_ALIVE_TIMEOUT_MS` | 可选 |
| `SHUTDOWN_TIMEOUT_MS` | `25000` | 同 main | 可选 |
| `APP_VERSION` | `dev` | 部署版本标识 | 可选 |

### 数据库 / Redis

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `DB_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | 与 main 同一个库（模板给本地开发串） | 必填 |
| `DB_SYNC` | `false` | 生产必须 false | 可选 |
| `DB_POOL_SIZE` | `10` | 连接池大小 | 可选 |
| `REDIS_URL` | `redis://localhost:6379/0` | 流式 pub/sub、队列、恢复租约都依赖它 | 必填 |
| `REDIS_KEY_PREFIX` | 空 | key 前缀 | 可选 |

### 对象存储

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `OBJECT_STORAGE_PROVIDER` | `s3` | `s3` / `cos` | 可选 |
| `OBJECT_STORAGE_REGION` | `us-east-1` | 区域 | 可选 |
| `OBJECT_STORAGE_BUCKET` | `billy-cli` | 桶名 | 可选 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | `minioadmin` | 访问密钥 | 生产必改 |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | `minioadmin` | 私有密钥 | 生产必改 |
| `OBJECT_STORAGE_ENDPOINT` | 空 | 不配 = 未启用；附件 / 文件能力用到时才报错 | 不配=未启用 |

### 日志

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | 日志级别；runtime 的 logger 前缀固定 `server` | 可选 |
| `LOKI_HOST` | 空 | Loki 地址（模板里注释掉）；不配只输出 stdout | 不配=未启用 |

### 监控告警 / 通知通道

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `ALERT_ENABLED` | `true` | 告警总开关 | 可选 |
| `ALERT_EMAIL_TO` | 空 | 告警邮件默认接收人 | 可选 |
| `MONITOR_INSTANCE_ID` | 空 | 实例标识；缺省 `hostname:pid` | 可选 |
| `MONITOR_SAMPLE_RETENTION_DAYS` | `30` | 指标样本保留天数 | 可选 |
| `ALERT_SMTP_HOST` | 空 | 不配则邮件通道不可用 | 不配=未启用 |
| `ALERT_SMTP_PORT` | `465` | SMTP 端口 | 可选 |
| `ALERT_SMTP_SECURE` | `true` | 是否 TLS | 可选 |
| `ALERT_SMTP_USER` | 空 | SMTP 用户名 | 可选 |
| `ALERT_SMTP_PASS` | 空 | SMTP 密码 | 可选 |
| `ALERT_SMTP_FROM` | 空 | 发件人 | 可选 |
| `LARK_NOTIFY_RECEIVE_ID` | 空 | 飞书通知接收人；不配不装配该通道 | 不配=未启用 |
| `LARK_NOTIFY_RECEIVE_ID_TYPE` | `open_id` | 接收人 id 类型 | 可选 |
| `LARK_APP_ID` | 空 | 飞书应用 App ID（与 SECRET 成对） | 不配=未启用 |
| `LARK_APP_SECRET` | 空 | 飞书应用 App Secret | 不配=未启用 |
| `LARK_DOMAIN` | `feishu` | `feishu` / `lark` | 可选 |

### 进程间令牌 / 模型网关 / 能力网关

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_INTERNAL_TOKEN` | 空 | runtime 校验 main 的 `x-internal-token`；空 = 全部 401 | 必填 |
| `MODEL_GATEWAY_URL` | `http://127.0.0.1:9992` | 模型目录唯一来源（runtime 不持供应商 key） | 必填 |
| `MODEL_GATEWAY_TOKEN` | 空 | 携带给 model-gateway；必须与 `MODEL_INTERNAL_TOKEN` 同值 | 必填 |
| `MODEL_GATEWAY_TIMEOUT_MS` | `60000` | 调模型网关超时（ms） | 可选 |
| `TOOL_GATEWAY_URL` | `http://127.0.0.1:9993` | 能力网关地址；空 = 没有服务侧能力（工具面只剩本地编排） | 不配=未启用 |
| `TOOL_GATEWAY_TOKEN` | 空 | 空则回落 `TOOL_INTERNAL_TOKEN`，再空回落 `dev-tool-token` | 可选 |
| `TOOL_INTERNAL_TOKEN` | 空 | 模板给 `dev-tool-token`；必须与 capability-gateway 同值 | 生产必改 |
| `TOOL_GATEWAY_TOOLS` | 内置 19 个工具名 | 远程工具白名单（逗号分隔）；**只对本地注册机 key 生效**，服务能力按目录下发 | 可选 |
| `TOOL_GATEWAY_DEADLINE_MS` | `310000` | 单次远程调用安全上限（ms） | 可选 |

### 技能

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_SKILLS_LIBRARY_DIR` | `~/.billy/skills` | 技能库落盘目录（DB 是事实源；启动会清掉库里不存在的技能目录，**不要**指向 `~/.agents/skills`） | 可选 |
| `GITHUB_TOKEN` | 空 | 技能链接导入用；读取时兼容 `GH_TOKEN` | 不配=未启用 |

### 上下文压缩（按 token 预算，比例相对模型窗口）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_CONTEXT_TRIGGER_RATIO` | `0.7` | 触发线：估算用量超过「窗口 × 本比例」就开始裁剪 / 压缩 | 可选 |
| `AGENT_CONTEXT_TRIM_TARGET_RATIO` | `0.5` | 裁剪 / 压缩目标：裁到「窗口 × 本比例」为止 | 可选 |
| `AGENT_CONTEXT_KEEP_RECENT_TURNS` | `3` | 最近几轮永不裁 | 可选 |
| `AGENT_CONTEXT_TOOL_RESULT_MAX_RATIO` | `0.1` | 单条工具结果给模型的视图上限（相对窗口；落库仍是完整原文） | 可选 |
| `AGENT_CONTEXT_TOOL_RESULT_TOTAL_RATIO` | `0.3` | 一轮内所有工具结果的累计上限（相对窗口） | 可选 |
| `AGENT_CONTEXT_FALLBACK_WINDOW` | `32000` | 未知模型的保守窗口（tokenlens 查不到时用，会打 warn） | 可选 |
| `AGENT_CONTEXT_MODEL_WINDOWS` | 空 | 按模型覆盖窗口：`model=窗口,model=窗口`（最高优先） | 可选 |

### 恢复 / 看门狗

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_DURABLE_ENABLED` | `true` | 可恢复执行：逐步落快照，崩溃后可续跑（会重放 / 重跑，真花钱） | 可选 |
| `AGENT_HEARTBEAT_TIMEOUT_MS` | `60000` | 心跳超时：超过就认为这一轮没人管了 | 可选 |
| `AGENT_RUN_TIMEOUT_MS` | `0`（schema 不限）/ 模板 `600000` | 单轮总时长上限；`0` = 不限，只靠心跳判活；模板给 10 分钟兜底 | 可选 |
| `AGENT_FIRST_TOKEN_TIMEOUT_MS` | `120000` | 首 token 超时（防「卡住不吐字」）；`0` = 关闭 | 可选 |
| `AGENT_WATCHDOG_INTERVAL_MS` | `30000` | 看门狗扫描间隔 | 可选 |
| `AGENT_MULTI_INSTANCE` | `false` | 多副本部署：`true` 时启动自检要求 Redis（恢复 / 停止 / 断线补发靠 Redis 租约） | 可选 |

### 子 agent

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_SUB_AGENT_MAX_PER_RUN` | `4` | 同一父 run 允许创建的子 agent 个数上限 | 可选 |
| `AGENT_SUB_AGENT_MAX_DEPTH` | `1` | 子 agent 深度上限 | 可选 |
| `AGENT_SUB_AGENT_MAX_STEPS` | `0` | 单个子 agent 步数上限；`0` = 沿用主 run 的步数上限（代码常量，默认 100 步） | 可选 |
| `AGENT_SUB_AGENT_TIMEOUT_MS` | `0` | 单个子 agent 墙钟上限；`0` = 沿用 `AGENT_RUN_TIMEOUT_MS` | 可选 |

### 工作区 / 文件能力上限

命令执行在 workspace-service；这些键只做 runtime 侧文件物化与工具入参的部署上限。

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_WORKSPACE_MODE` | `enforce` | 沙箱不可用即拒绝执行 | 可选 |
| `AGENT_WORKSPACE_SANDBOX_NETWORK` | `deny` | 沙箱联网策略 | 可选 |
| `AGENT_WORKSPACE_PROBE_TIMEOUT_MS` | `2000` | 沙箱探测超时 | 可选 |
| `AGENT_COMMAND_WORK_DIR` | 空 | 工作区根；空 = 不覆盖（不设 workDir）。容器 / k8s 里必须与挂载路径一致 | 可选 |
| `AGENT_FILE_MAX_BYTES` | 空 | 单文件硬上限（字节）；不设 = 不做该维度部署级夹紧 | 可选 |
| `AGENT_FILE_MAX_FILES` | 空 | 单会话文件数硬上限 | 可选 |
| `AGENT_FILE_MAX_TOTAL_BYTES` | 空 | 单会话总字节硬上限 | 可选 |
| `AGENT_FILE_READ_MAX_BYTES` | 空 | `read-file` / `replace` 的读取上限 | 可选 |
| `AGENT_FILE_PAGE_LINES_MAX` | 空 | 单页最多行数 | 可选 |
| `AGENT_FILE_PAGE_CHARS_MAX` | 空 | 单页最多字符数 | 可选 |
| `AGENT_FILE_WRITE_MAX_BYTES` | 空 | 单次写入 / 替换 / 追加内容上限 | 可选 |
| `AGENT_FILE_SEARCH_MAX_FILES` | 空 | `file-search` 扫描文件数上限 | 可选 |
| `AGENT_FILE_SEARCH_MAX_BYTES` | 空 | `file-search` 扫描字节上限 | 可选 |
| `AGENT_FILE_SEARCH_MAX_RESULTS` | 空 | `file-search` 结果数上限 | 可选 |
| `AGENT_FILE_WORKSPACE_MAX_FILES` | 空 | `workspace-files` 文件数上限 | 可选 |
| `AGENT_FILE_WORKSPACE_MAX_DEPTH` | 空 | `workspace-files` 深度上限 | 可选 |
| `AGENT_TOOL_PAGE_BYTES_MAX` | `8192` | 单次给模型的工具出参硬上限（字节），后台配置也突破不了 | 可选 |
| `AGENT_TOOL_MAX_PAGES_PER_TURN` | `5` | 每轮取页次数硬上限 | 可选 |

> `AGENT_FILE_*` 不设时，文件能力按代码默认值运行（10MB / 200 个 / 100MB / 5MB / 200 行 / 64K 字符 /
> 10MB / 500 个 / 20MB / 50 条 / 500 个 / 16 层），这些键只是在上面再压一层部署上限。

### 排障开关

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `DISABLE_RUN_QUEUE_DISPATCHER` | 空 | `1` = 停用自动轮次派发，只做手动 run（直接读 `process.env`） | 可选 |

### 可选：Kafka

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `KAFKA_BROKERS` | 空 | 空 = 不装配 `KafkaModule` | 不配=未启用 |
| `KAFKA_CLIENT_ID` | `app` | 客户端标识 | 可选 |
| `KAFKA_TOPIC_PREFIX` | `app` | topic 前缀 | 可选 |
| `KAFKA_GROUP_ID_PREFIX` | `app` | 消费组前缀 | 可选 |
| `KAFKA_CONNECTION_TIMEOUT_MS` | `3000` | 建连超时 | 可选 |
| `KAFKA_REQUEST_TIMEOUT_MS` | `15000` | 单次请求超时 | 可选 |
| `KAFKA_RETRY_COUNT` | `2` | 重试次数 | 可选 |
| `KAFKA_RETRY_INITIAL_DELAY_MS` | `300` | 重试初始间隔 | 可选 |
| `KAFKA_UNAVAILABLE_COOLDOWN_MS` | `5000` | 不可用冷却期 | 可选 |

---

## model-gateway

内部模型网关：只读 `ai_providers` / `ai_models`，跑模型调用协议适配、key 池、用量落库；
供应商 / 模型由 main 维护，本服务不对外。
配置：`apps/model-gateway/.env.example` → `apps/model-gateway/.env`；端口 **9992**。

### 运行 / 端口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | `9992` | 监听端口；兼容别名 `MODEL_GATEWAY_PORT`（别名优先） | 可选 |

### 数据库 / Redis

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `DB_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | 只读配置表 + 写 `model_gateway_usage` 用量 | 必填 |
| `DB_POOL_SIZE` | `10` | 连接池大小 | 可选 |
| `REDIS_URL` | `redis://localhost:6379/0` | key 池冷却 / 缓存；启动即建连（不可用则启动失败） | 必填 |
| `REDIS_KEY_PREFIX` | 空 | key 前缀 | 可选 |

### 鉴权

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `MODEL_INTERNAL_TOKEN` | `dev-model-token` | 网关校验的 `x-internal-token`；调用方用 `MODEL_GATEWAY_TOKEN` 携带，两者必须同值 | 生产必改 |

### 网关行为

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `MODEL_GATEWAY_CACHE_TTL_MS` | `30000` | 模型目录缓存时长（配置变更靠事件 + TTL 兜底） | 可选 |
| `MODEL_GATEWAY_FIRST_BYTE_TIMEOUT_MS` | `120000` | 上游首字节超时（ms） | 可选 |
| `MODEL_GATEWAY_IDLE_TIMEOUT_MS` | `180000` | 流中空闲超时（ms）：超过没有新块就 abort 上游 | 可选 |

### 日志

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | 日志级别 | 可选 |
| `LOG_PREFIX` | `model-gateway` | pino name / Loki label | 可选 |
| `LOG_PRETTY` | 空 | 是否彩色美化；空 = 按 `NODE_ENV`（非 production 美化），只有 `false` 关闭 | 可选 |

---

## capability-gateway

能力网关：能力目录 / 授权过滤 / 调用路由 / 限流校验 / MCP client / 审计；**不执行能力**，
按注册表把调用转发给 common-capability 与 workspace-service。
配置：`apps/capability-gateway/.env.example` → `apps/capability-gateway/.env`；端口 **9993**。

### 运行 / 端口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | `9993` | 监听端口；兼容别名 `TOOL_GATEWAY_PORT`（别名优先） | 可选 |

### 数据库 / Redis

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `DB_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | 审计（`ai_tool_audit`）、工具配置、能力目录、服务授权 | 必填 |
| `DB_POOL_SIZE` | `10` | 连接池大小 | 可选 |
| `REDIS_URL` | `redis://localhost:6379/0` | 能力注册表 / 限流计数 / 任务索引；启动即建连（不可用则启动失败） | 必填 |
| `REDIS_KEY_PREFIX` | 空 | key 前缀 | 可选 |

### 鉴权

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `TOOL_INTERNAL_TOKEN` | `dev-tool-token` | gateway / worker 共享的内部令牌；调用方（main / runtime）、worker 登记侧必须同值 | 生产必改 |

### 注册表 / 路由 / 限流 / SSRF

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `TOOL_WORKER_STALE_MS` | `30000` | 注册表 freshness：worker 超过这个时间没心跳就不参与选路 | 可选 |
| `TOOL_GATEWAY_TIMEOUT_MS` | `310000` | 单次调用安全上限（ms，最大 360000）；请求里的 `deadlineMs` 更小则听请求的 | 可选 |
| `TOOL_GATEWAY_RATE_LIMIT_PER_MINUTE` | `60` | 单用户 + 单能力每分钟上限（网关侧限流，不是 run 准入） | 可选 |
| `TOOL_GATEWAY_ALLOW_PRIVATE_NETWORK` | 空 | 是否允许外部服务指向内网 / 回环；空 = 生产禁止、开发 / 测试放行。**生产必须显式 `false`** | 生产必改 |

### 日志

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | 日志级别 | 可选 |
| `LOG_PREFIX` | `capability-gateway` | pino name / Loki label | 可选 |
| `LOG_PRETTY` | 空 | 空 = 按 `NODE_ENV` 推断；只有 `false` 关闭 | 可选 |

---

## common-capability

通用能力执行：登记服务 `common`（memory 3 / web 3 / read-tool-result 1 / file-submit·file-download 2，
共 9 个能力）。bash 与工作区文件能力在 workspace-service。
配置：`apps/common-capability/.env.example` → `apps/common-capability/.env`；端口 **9994**。

### 运行 / 端口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | `9994` | 监听端口；兼容别名 `TOOL_WORKER_PORT`（别名优先） | 可选 |

### 数据库 / Redis

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `TOOL_WORKER_DB_URL` | 空 | 能力执行用的数据库（受限账号）；空 = 回落 `DB_URL` | 可选 |
| `DB_POOL_SIZE` | `10` | 连接池大小 | 可选 |
| `REDIS_URL` | `redis://localhost:6379/0` | 能力注册表 / 限流 / 任务索引；启动即建连（不可用则启动失败） | 必填 |
| `REDIS_KEY_PREFIX` | 空 | key 前缀 | 可选 |

### 鉴权 / 能力网关 / 工作区执行面

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `TOOL_INTERNAL_TOKEN` | `dev-tool-token` | gateway / worker 共享令牌；必须与 capability-gateway 同值 | 生产必改 |
| `CAPABILITY_GATEWAY_URL` | 空 | 能力网关地址；空 = 跳过登记（只打 warn），兼容回落 `TOOL_GATEWAY_URL` | 不配=未启用 |
| `WORKSPACE_SERVICE_URL` | `http://127.0.0.1:9995` | `file-submit` / `file-download` 的 `WorkspaceFsPort` 目标 | 必填 |
| `WORKSPACE_INTERNAL_TOKEN` | 空 | 空则回落 `TOOL_INTERNAL_TOKEN`，再空回落 `dev-workspace-token` | 可选 |

### 注册身份 / 回调 / 并发

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `TOOL_WORKER_ID` | `hostname-pid` | 注册表里的唯一 id；多副本必须唯一 | 可选 |
| `TOOL_WORKER_ENDPOINT` | `http://127.0.0.1:9994` | 本实例地址（gateway 选路后直连它）；k8s 下用 Pod IP | 可选 |
| `TOOL_WORKER_HEARTBEAT_MS` | `10000` | 心跳间隔（注册表 freshness 用） | 可选 |
| `TOOL_WORKER_MAX_CONCURRENCY` | `8` | 本 worker 同时执行上限 | 可选 |
| `TOOL_WORKER_COMMAND_TIMEOUT_MS` | `300000` | 未登记本地 bash 执行体上限（bash 已迁 workspace-service，保留兼容） | 可选 |
| `TOOL_WORKER_MAX_OUTPUT_BYTES` | `65536` | 每条流（stdout / stderr）输出上限 | 可选 |
| `TOOL_WORKER_WORKSPACE_ROOT` | `<tmpdir>/billy-common-capability` | 临时工作区根（可丢弃）；会话工作区真相在对象存储 / workspace-service | 可选 |

### 对象存储

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `OBJECT_STORAGE_PROVIDER` | `s3` | `s3` / `cos` | 可选 |
| `OBJECT_STORAGE_REGION` | `us-east-1` | 区域 | 可选 |
| `OBJECT_STORAGE_BUCKET` | `billy-cli` | 桶名 | 可选 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` | `minioadmin` | 访问密钥 | 生产必改 |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | `minioadmin` | 私有密钥 | 生产必改 |
| `OBJECT_STORAGE_ENDPOINT` | 空 | 不配 = 未启用（`file-submit` / `file-download` 用到时才报错） | 不配=未启用 |

### 日志

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | 日志级别 | 可选 |
| `LOG_PREFIX` | `common-capability` | pino name / Loki label | 可选 |
| `LOG_PRETTY` | 空 | 空 = 按 `NODE_ENV` 推断；只有 `false` 关闭 | 可选 |

### 联网能力（web-fetch / web-request / web-search）出网预算

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `TOOL_WEB_FETCH_TIMEOUT_MS` | `20000` | 抓取超时 | 可选 |
| `TOOL_WEB_FETCH_MAX_BYTES` | `2097152` | 单次抓取最大字节 | 可选 |
| `TOOL_WEB_FETCH_PAGE_LINES` | `1000` | 单页最多行数 | 可选 |
| `TOOL_WEB_FETCH_CACHE_TTL_MS` | `1800000` | 抓取缓存 TTL | 可选 |
| `TOOL_WEB_FETCH_ALLOW_PRIVATE_NETWORK` | `false` | 是否允许抓内网 / 回环地址（生产保持 false） | 可选 |
| `TOOL_WEB_FETCH_USER_AGENT` | 空 | 自定义 User-Agent | 可选 |
| `TOOL_WEB_SEARCH_API_KEY` | 空 | `web-search` 的部署级兜底密钥（优先用后台工具配置里的 `secrets.apiKey`） | 不配=未启用 |

### 本地沙箱探测

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_WORKSPACE_MODE` | `enforce` | common 不执行命令，保持默认即可 | 可选 |
| `AGENT_WORKSPACE_SANDBOX_NETWORK` | `deny` | 沙箱联网策略 | 可选 |
| `AGENT_WORKSPACE_PROBE_TIMEOUT_MS` | `2000` | 沙箱探测超时 | 可选 |

---

## workspace-service

工作区执行面：登记服务 `workspace`（bash + 工作区文件共 8 个能力），按 `ai_workspaces` 配置起
工作区容器 / Pod、执行命令与文件读写；运行态不回写 DB。
配置：`apps/workspace-service/.env.example` → `apps/workspace-service/.env`；端口 **9995**。

### 运行 / 端口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | `9995` | 监听端口；兼容别名 `WORKSPACE_SERVICE_PORT`（别名优先） | 可选 |

### 数据库

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `WORKSPACE_DB_URL` | 空 | 只读 `ai_workspaces` 的连接串；空 = 回落 `DB_URL` | 可选 |
| `DB_POOL_SIZE` | `10` | 连接池大小 | 可选 |

### 令牌 / 网关登记

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `WORKSPACE_INTERNAL_TOKEN` | `dev-workspace-token` | main / common-capability 调它用的内部令牌 | 生产必改 |
| `TOOL_INTERNAL_TOKEN` | `dev-tool-token` | 向能力网关登记时携带的令牌；必须与 capability-gateway 同值 | 生产必改 |
| `MAIN_URL` | `http://127.0.0.1:9989` | 控制面地址：初始化 / 同步时解析凭据、凭据入库都调它。**main 端口不同必须显式配** —— 不配会静默回落默认值，改端口部署后启动不报错、直到第一条凭据命令才 `fetch failed` | 部署改端口时必改 |
| `WORKSPACE_GATEWAY_URL` | 空 | 能力网关地址；空 = 跳过登记（只打 warn），兼容回落 `TOOL_GATEWAY_URL` | 不配=未启用 |
| `WORKSPACE_SERVICE_ENDPOINT` | `http://127.0.0.1:9995` | 登记时上报的本实例地址（网关路由后回调 `/invoke`）；compose / 多机要写成对网关可达的地址 | 可选 |
| `WORKSPACE_INSTANCE_ID` | `hostname-pid` | 实例 id；单副本通常不用配，多副本必须每个 Pod 唯一（k8s 用 POD_NAME） | 可选 |
| `WORKSPACE_MULTI_INSTANCE` | `false` | 多副本开关；kubernetes 后端直接可用，同宿主 Docker 还需 `WORKSPACE_ALLOW_SHARED_DOCKER=true`；打开后装配 RedisModule 并要求 `REDIS_URL` | 多副本必配 |
| `WORKSPACE_ALLOW_SHARED_DOCKER` | `false` | 仅开发 / 单机：允许同宿主 Docker 多副本（所有副本共享同一个 daemon）；跨宿主仍不支持 | 同宿主 Docker 多副本时必配 |

### 容器后端

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `WORKSPACE_CONTAINER_RUNTIME` | `docker` | `docker`（单机 / compose，dockerode 直连 Engine API）或 `kubernetes`（云端 Pod，走 kubectl） | 可选 |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | docker 后端的 Engine API socket（直接读 `process.env`，compose 里需挂载该 socket） | 可选 |
| `WORKSPACE_KUBECTL_BIN` | `kubectl` | kubernetes 后端的 kubectl 路径 | 可选 |
| `WORKSPACE_K8S_NAMESPACE` | `billy` | 工作区 Pod 所在命名空间 | 可选 |

### 资源 / 镜像 / 本地根 / 空闲回收

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `WORKSPACE_CONTAINER_MEMORY` | `2g` | 工作区容器内存上限 | 可选 |
| `WORKSPACE_CONTAINER_NETWORK` | `bridge` | 工作区容器网络出口：`bridge` 出网（装依赖 / git clone 需要）/ `none` 断网（镜像必须预烘依赖，否则初始化失败） | 可选 |
| `WORKSPACE_CONTAINER_CPUS` | `2` | 工作区容器 CPU 上限 | 可选 |
| `WORKSPACE_CONTAINER_PIDS_LIMIT` | `512` | 工作区容器 pid 上限 | 可选 |
| `WORKSPACE_DEFAULT_IMAGE` | `billy-workspace:latest` | 工作区镜像；模板对齐发布版本 `billy-workspace:2026.11.0`，必须与 `docker/Dockerfile.workspace-image` 构建出的 tag 一致 | 生产必改 |
| `WORKSPACE_LOCAL_ROOT` | `<tmpdir>/billy-workspaces` | local 后端（仅自托管 / 本地联调）的根；docker / kubernetes 后端不用 | 可选 |
| `WORKSPACE_IDLE_TIMEOUT_MS` | `7200000` | 空闲回收（默认 2 小时）；`0` = 常驻不回收 | 可选 |
| `WORKSPACE_REAP_INTERVAL_MS` | `60000` | 回收扫描间隔 | 可选 |

### 本地沙箱（local 后端）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `AGENT_WORKSPACE_MODE` | `enforce` | 模板给 `off`（本地联调）；docker / kubernetes 后端靠容器边界，本键只在 local 后端生效 | 可选 |
| `AGENT_WORKSPACE_SANDBOX_NETWORK` | `deny` | 沙箱联网策略 | 可选 |
| `AGENT_WORKSPACE_PROBE_TIMEOUT_MS` | `2000` | 沙箱探测超时 | 可选 |

### 日志

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `LOG_LEVEL` | `info` | 日志级别 | 可选 |
| `LOG_PREFIX` | `workspace-service` | pino name / Loki label | 可选 |
| `LOG_PRETTY` | 空 | 空 = 按 `NODE_ENV` 推断；只有 `false` 关闭 | 可选 |

---

## admin

Next.js 后台：管理台 + 文件分享页（`/s/{token}`），只连 main。
配置：`apps/admin/.env.example` → `apps/admin/.env`；端口 dev **9845**（容器内 9845、宿主 9846）。

### 服务端地址（注意构建期 / 运行时）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:9989` | **构建期内联**：浏览器端 API 地址（客户端组件 / 请求用），改完要重新 build | 构建期 |
| `SERVER_URL` | 空（回落上面的 `NEXT_PUBLIC_SERVER_URL`） | **运行时读取**：SSR / Server Actions / 路由守卫访问的 API 地址，容器里指向内网（如 `http://main:9989`） | 可选 |
| `NEXT_PUBLIC_STORAGE_URL` | `http://localhost:9000/billy-cli` | **构建期内联**：对象存储基地址（仅用于绝对 URL 兼容；预览 / 下载走服务端签发的预签名 URL） | 构建期 |

> 改了 `NEXT_PUBLIC_STORAGE_URL` 的 host / port，还要同步 `apps/admin/next.config.ts` 的
> `images.remotePatterns`，否则 `next/image` 会拒绝加载。

### 文件分享

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `SHARE_INTERNAL_SECRET` | 空 | **运行时读取**（只在服务端，别加 `NEXT_PUBLIC_*` 前缀）：分享页的 Hono 路由向 main 的 `/share/resolve` 换取预签名 URL 时携带；必须与 main 的 `SHARE_INTERNAL_SECRET` 一致；空 = 分享字节取不到（其它页面不受影响） | 不配=未启用 |

### 其它

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | 空 | 监听端口；本地 dev 固定 9845（`next dev --port 9845`），生产 standalone 由启动脚本 / 容器注入（镜像 `ENV PORT=9845`） | 可选 |
| `NEXT_TELEMETRY_DISABLED` | 空 | 置 `1` 关闭 Next 遥测上报（Next 自己读取，不经过应用代码） | 可选 |

---

## web

Next.js 前台：用户门户，只连 main。
配置：`apps/web/.env.local.example` → `apps/web/.env.local`；端口 dev **9840**（容器内 3001）。

### 服务端地址（注意构建期 / 运行时）

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SERVER_URL` | `http://localhost:9989` | **构建期内联**：浏览器端 API 地址，改完要重新 build | 构建期 |
| `SERVER_URL` | 空（回落上面的 `NEXT_PUBLIC_SERVER_URL`） | **运行时读取**：SSR / Server Actions 访问的 API 地址，容器里指向内网（如 `http://main:9989`） | 可选 |
| `NEXT_PUBLIC_STORAGE_URL` | `http://localhost:9000/billy-cli` | **构建期内联**：对象存储公开 URL（头像 / 附件展示）；必须与 main 的 `OBJECT_STORAGE_ENDPOINT` + `OBJECT_STORAGE_BUCKET` 一致，否则拼出 404 地址 | 构建期 |

### 后台入口

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_ADMIN_URL` | `http://localhost:9845` | **构建期内联**：Admin 后台地址（首页跳转链接） | 构建期 |

### 其它

| 变量 | 默认 | 说明 | 必填 |
| --- | --- | --- | --- |
| `PORT` | 空 | 监听端口；dev 与本地 `start` 固定 9840，容器内由 Dockerfile 注入 3001 | 可选 |
| `NEXT_TELEMETRY_DISABLED` | 空 | 置 `1` 关闭 Next 遥测上报（Next 自己读取） | 可选 |

> 前端镜像的构建说明：`docker/Dockerfile.admin` / `Dockerfile.web` 没有声明 `NEXT_PUBLIC_*` 构建参数，
> 且 `.dockerignore` 排除了 `**/.env`，所以**镜像里的 `NEXT_PUBLIC_*` 是代码默认值**
> （`http://localhost:9989` / `http://localhost:9000/billy-cli` / `http://localhost:9845`）。
> 浏览器端地址必须在构建期决定；运行时只有 `SERVER_URL` / `SHARE_INTERNAL_SECRET` 可改。

---

## 已移除 / 不再读取的变量

下面这些键本次从模板 / 代码里清理掉了。**旧 `.env` 里留着不会报错**：`mapXxxEnv` 只读取认识的变量名，
多出来的键被静默忽略。可对照本表删减。

| 变量 | 归属 | 为什么移除 |
| --- | --- | --- |
| `TOOL_WORKER_URL` | capability-gateway | 网关不再直连 worker URL：选路只走注册表（worker 启动时登记 endpoint） |
| `TOOL_WORKER_VERSION` / `TOOL_WORKER_ZONE` | common-capability | worker 侧无消费方，登记 / 选路都不需要这两个键 |
| `TOOL_WORKER_STALE_MS`（common 侧） | common-capability | 新鲜度判定在 gateway 侧；**capability-gateway 仍读同名键**，worker 不读 |
| `WORKSPACE_DOCKER_BIN` | workspace-service | docker 后端已改 dockerode 直连 Engine API，只认 `DOCKER_SOCKET`；kubernetes 后端用 `WORKSPACE_KUBECTL_BIN` |
| `TOOL_GATEWAY_TOOLS` / `TOOL_GATEWAY_DEADLINE_MS`（main 侧） | main | 远程工具白名单 / 超时只在 runtime 的 `remote-tool.client.ts` 读取（main 没有远程工具调用） |
| runtime `JWT_SECRET` / `JWT_EXPIRES_IN` | agent-runtime | runtime 不做鉴权签发 / 校验，JWT 只在 main |
| runtime `PASSWORD_HASH_ROUNDS` | agent-runtime | 密码哈希只在 main 的账号模块 |
| runtime `SHARE_INTERNAL_SECRET` | agent-runtime | 分享接口在 main（`/share/resolve`）与 admin（分享页） |
| runtime `AUTH_ENABLED` / `RESET_PASSWORD_TOKEN_TTL_MINUTES` / `WEB_URL` | agent-runtime | 鉴权 / 找回密码属于控制面（main） |
| runtime `RATE_LIMIT_WHITELIST` / `RATE_LIMIT_TRUST_PROXY` | agent-runtime | 限流在 main；网关侧另有 `TOOL_GATEWAY_RATE_LIMIT_PER_MINUTE` |
| runtime `MASTRA_MODEL` / `MASTRA_API_KEY` / `MASTRA_BASE_URL` | agent-runtime | 模型配置改由 model-gateway 从库里读；`MASTRA_*` 只作 main 的首次种子 |
| runtime `AGENT_SEED_FROM_ENV` | agent-runtime | 种子逻辑在 main 的 `ai-model`（runtime 不再装配 `aiModel`） |
| runtime `AGENT_CONTEXT_COMPACT_TARGET_RATIO` | agent-runtime | 压缩 / 裁剪共用一个目标值 `AGENT_CONTEXT_TRIM_TARGET_RATIO`，代码无独立读取 |
| `AI_MODEL_ENCRYPTION_KEY`（main / runtime 模板） | main / agent-runtime | 供应商密钥已改明文存储；现只有一次性迁移脚本 `1790825000000-PlainTextSecrets` 引用 |
| runtime `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_REAL_NAME` | agent-runtime | 首个管理员种子 `pnpm seed:admin` 跑在 main，runtime 不读 |
| main 的整套 `agent` 命名空间（41 个运行期旋钮） | main | agent loop 归 agent-runtime；main 只保留 `AGENT_RUNTIME_URL` / `AGENT_INTERNAL_TOKEN` / `AGENT_SEED_FROM_ENV` / 工作区边界 4 键，共 7 个 `AGENT_*` |

main 被移除的 41 个 `AGENT_*` 旋钮（运行期旋钮归 agent-runtime；命令 / 联网执行相关的键已随执行面迁移，
不再存在同名环境变量）：

```text
AGENT_COMMAND_ENABLED AGENT_COMMAND_MAX_OUTPUT_BYTES AGENT_COMMAND_TIMEOUT_MS
AGENT_CONTEXT_COMPACT_TARGET_RATIO AGENT_CONTEXT_FALLBACK_WINDOW AGENT_CONTEXT_KEEP_RECENT_TURNS
AGENT_CONTEXT_MODEL_WINDOWS AGENT_CONTEXT_TOOL_RESULT_MAX_RATIO AGENT_CONTEXT_TOOL_RESULT_TOTAL_RATIO
AGENT_CONTEXT_TRIGGER_RATIO AGENT_CONTEXT_TRIM_TARGET_RATIO AGENT_DURABLE_ENABLED
AGENT_FILE_MAX_BYTES AGENT_FILE_MAX_FILES AGENT_FILE_MAX_TOTAL_BYTES AGENT_FILE_PAGE_CHARS_MAX
AGENT_FILE_PAGE_LINES_MAX AGENT_FILE_READ_MAX_BYTES AGENT_FILE_SEARCH_MAX_BYTES
AGENT_FILE_SEARCH_MAX_FILES AGENT_FILE_SEARCH_MAX_RESULTS AGENT_FILE_WORKSPACE_MAX_DEPTH
AGENT_FILE_WORKSPACE_MAX_FILES AGENT_FILE_WRITE_MAX_BYTES AGENT_FIRST_TOKEN_TIMEOUT_MS
AGENT_HEARTBEAT_TIMEOUT_MS AGENT_MULTI_INSTANCE AGENT_RUN_TIMEOUT_MS
AGENT_SKILLS_LIBRARY_DIR AGENT_SUB_AGENT_MAX_DEPTH AGENT_SUB_AGENT_MAX_PER_RUN
AGENT_SUB_AGENT_MAX_STEPS AGENT_SUB_AGENT_TIMEOUT_MS AGENT_TOOL_MAX_PAGES_PER_TURN
AGENT_TOOL_PAGE_BYTES_MAX AGENT_WATCHDOG_INTERVAL_MS AGENT_WEB_ALLOW_PRIVATE_NETWORK
AGENT_WEB_ENABLED AGENT_WEB_MAX_BYTES AGENT_WEB_TIMEOUT_MS
```

---

## 模板差异与迁移提示

1. **main 与 agent-runtime 的 `.env` 不再互相复制**：runtime 不再有 JWT / 密码 / 分享 / 限流 /
   `MASTRA_*` / 管理员种子等控制面键；main 不再有 41 个运行期旋钮。两边模板的「运行 / DB / Redis /
   对象存储 / 日志 / 监控 / 通知 / Kafka」是各自独立的一份，改一边不会自动同步。
2. **旧 `.env` 可以继续用**：多出来的键被忽略、不会报错；但请按本文档删减，避免「改了没生效」的错觉
   （例如在 main 的 `.env` 里改 `AGENT_RUN_TIMEOUT_MS`，实际读的是 runtime 的）。
3. **runtime 的 `PORT` 必须显式 9990**：schema 默认 9989（与 main 同源），只写默认值会导致端口冲突 /
   main 的 `AGENT_RUNTIME_URL` 连不上；模板与 compose / k8s 都已显式写 9990。
4. **`AGENT_RUN_TIMEOUT_MS` 语义差异**：模板值 `600000`（10 分钟兜底），schema 默认 `0`（不限，只靠心跳
   判活）。沿用模板即 10 分钟硬上限；要真正不限，显式写 `0`。
5. **端口别名**：模板只写 `PORT`，但 `MODEL_GATEWAY_PORT` / `TOOL_GATEWAY_PORT` / `TOOL_WORKER_PORT` /
   `WORKSPACE_SERVICE_PORT` 仍被读取且**优先于 `PORT`**。沿用旧 `.env` 时若同时有两份不同端口值，
   以别名键为准。
6. **model-gateway / workspace-service 不在 bootstrap 清单里**：新克隆的仓库要手动 `cp` 模板，
   否则 `pnpm dev:stack` 里这两个服务会用 schema 默认值（端口 / 数据库都可能不对）。
7. **`.env` 会覆盖真实环境变量（6 个 Nest 服务）**：本机开发时命令行临时覆盖无效；容器 / CI 不要放
   `.env`，否则编排层注入的值会被文件覆盖。
8. **admin / web 的 `NEXT_PUBLIC_*` 是构建期**：镜像构建时没有注入 `NEXT_PUBLIC_*` 参数（且
   `.dockerignore` 排除 `.env`），所以镜像里是代码默认值；浏览器端地址要在构建期决定，
   运行时只有 `SERVER_URL` / `SHARE_INTERNAL_SECRET` 生效。
9. **模板与 schema 的默认值不一定相同**：模板给的是「本地开发推荐值」（如 `DB_URL`、对象存储凭证、
   `WORKSPACE_DEFAULT_IMAGE`），schema 给的是「能启动的兜底值」。本文「默认」列以 schema 为准，
   模板差异在说明里单独标注。

---

## 核对命令

下面的脚本都从仓库根目录执行（macOS / Linux 的 bash；`comm` 需要两个文件都已 `sort`）。

### 1. 模板键 vs 代码读取（发现「模板有、代码不读」与「代码读、模板没有」）

```bash
for app in main agent-runtime model-gateway capability-gateway common-capability workspace-service admin web; do
  case $app in
    web) tpl=apps/web/.env.local.example ;;
    *)   tpl=apps/$app/.env.example ;;
  esac
  printf '\n== %s\n' "$app"
  # 模板键（含注释掉的「可选 / 未启用」键）
  grep -oE '^#? *[A-Z_][A-Z0-9_]*=' "$tpl" | sed -E 's/^# *//; s/=$//' | sort -u > "/tmp/tpl.$app"
  # 代码读取名：process.env.X / process.env['X'] / app-config 里的 env.X
  grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*|process\.env\["'\''[A-Z_][A-Z0-9_]*"'\''\]|env\.[A-Z_][A-Z0-9_]*' \
    apps/$app/src apps/$app/scripts 2>/dev/null \
    | sed -E 's/.*[.[]//; s/["'\'']\]$//' | sort -u > "/tmp/code.$app"
  echo '- 模板有 / 代码不读：'; comm -23 "/tmp/tpl.$app" "/tmp/code.$app"
  echo '- 代码读 / 模板没有：'; comm -13 "/tmp/tpl.$app" "/tmp/code.$app"
done
```

当前基线的预期结果：

- 「模板有 / 代码不读」：6 个 Nest 服务应为空；admin / web 只有 `PORT`、`NEXT_TELEMETRY_DISABLED`
  （由 Next 自己读取，不经过应用代码）。
- 「代码读 / 模板没有」只应出现这些**别名 / 框架键**：`NODE_ENV`（运行环境自动设置）、
  `GH_TOKEN`（`GITHUB_TOKEN` 的兼容名）、`MODEL_GATEWAY_PORT` / `TOOL_GATEWAY_PORT` /
  `TOOL_WORKER_PORT` / `WORKSPACE_SERVICE_PORT`（端口别名），以及 common / workspace 侧作为回落名的
  `DB_URL`、`TOOL_GATEWAY_URL`。任何**其它**输出都说明模板与代码脱节。

### 2. 确认「已移除的键」没有读取方

**全仓范围**已无读取方的键（应全部没有命中）：

```bash
for k in TOOL_WORKER_URL TOOL_WORKER_VERSION TOOL_WORKER_ZONE WORKSPACE_DOCKER_BIN \
         AGENT_CONTEXT_COMPACT_TARGET_RATIO; do
  hits=$(grep -rnE "process\.env\.$k\b|env\.$k\b" apps/*/src packages/*/src scripts 2>/dev/null)
  if [ -n "$hits" ]; then echo "仍被读取：$k"; echo "$hits"; else echo "OK（无读取方）：$k"; fi
done
```

**只在某个 app 侧移除**的键，要限定目录再查（同名键在别的服务仍有效，全仓查会误报）：

```bash
# main 侧移除、runtime 仍读：TOOL_GATEWAY_TOOLS / TOOL_GATEWAY_DEADLINE_MS
grep -rnE 'process\.env\.(TOOL_GATEWAY_TOOLS|TOOL_GATEWAY_DEADLINE_MS)\b|env\.(TOOL_GATEWAY_TOOLS|TOOL_GATEWAY_DEADLINE_MS)\b' \
  apps/main/src || echo 'OK（main 无读取方）'
# common 侧移除、gateway 仍读：TOOL_WORKER_STALE_MS
grep -rnE 'process\.env\.TOOL_WORKER_STALE_MS\b|env\.TOOL_WORKER_STALE_MS\b' \
  apps/common-capability/src || echo 'OK（common 无读取方）'
```

**历史来源**：这些键的旧模板可从「清理前的提交」里查到（若清理提交已落地，就把 HEAD 换成它的父提交）：

```bash
git show HEAD:apps/main/.env.example | grep -E '^AGENT_' | head
```

### 3. 文档覆盖率：8 个模板里每个键都必须出现在本文

```bash
cat apps/*/.env.example apps/web/.env.local.example \
  | grep -oE '^#? *[A-Z_][A-Z0-9_]*=' | sed -E 's/^# *//; s/=$//' | sort -u > /tmp/keys.txt
missing=0
while read -r k; do
  grep -q "\`$k\`" docs/guide/env.md || { echo "MISSING: $k"; missing=1; }
done < /tmp/keys.txt
[ "$missing" -eq 0 ] && echo "OK：模板键全部覆盖（$(wc -l < /tmp/keys.txt) 个）"
```

### 4. 反向覆盖：本文提到的变量都应能在模板 / 代码里找到

以下脚本依赖 §1 生成的 `/tmp/tpl.*` 与 `/tmp/code.*`：

```bash
grep -oE '`[A-Z][A-Z0-9_]+`' docs/guide/env.md | tr -d '`' | sort -u > /tmp/doc-keys.txt
cat /tmp/tpl.* /tmp/code.* | sort -u > /tmp/known-keys.txt
echo '--- 文档里有、模板与代码都没有（应只剩「已移除」表里的键）'
comm -23 /tmp/doc-keys.txt /tmp/known-keys.txt
```

「已移除 / 不再读取的变量」一节列出的键**故意**不在当前模板 / 代码里；它们的历史来源用
`git show HEAD:apps/<app>/.env.example` 核对。除该节之外出现任何未命中项，都说明文档写了不存在的变量。
