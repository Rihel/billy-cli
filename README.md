# Billy

[![Node](https://img.shields.io/badge/node-%E2%89%A526-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-12-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![NestJS](https://img.shields.io/badge/NestJS-12-e0234e?logo=nestjs&logoColor=white)](https://nestjs.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Rihel/billy-cli?style=social)](https://github.com/Rihel/billy-cli)

> 一个可以自托管的 AI 应用基础工程：会话、流式输出、工具调用、能力网关、模型网关、工作区隔离与审计
> 都在仓库里，配好依赖和模型 key 后可以在本机跑起来。
>
> 它不是成品 SaaS，也没有生产规模验证 —— 哪些能用、哪些只是骨架、哪些还没验证，见「现状与限制」。
>
> 技术形态：NestJS 12 + TypeScript 7 + Next.js 16 的全栈 Monorepo（pnpm + Turbo）。后端按
> 「控制面 / 执行面 / 内网服务」拆成 6 个 Nest 进程 —— main（公网 API / 控制面）+ agent-runtime（agent loop）
> + model-gateway / capability-gateway / common-capability / workspace-service（只在内网互调），
> 通用能力收在 `@repo/kits`；前端 Web 与 Admin 两套独立入口，共用 `@repo/ui` 与 Tailwind 4。

GitHub：[Rihel/billy-cli](https://github.com/Rihel/billy-cli)

## 它适合谁，不适合谁

**适合**

- 想在一台机器上跑通「对话 → 工具调用 → 工作区执行 → 审计」整条链路的开发者；
- 需要一套可以改的 AI 应用骨架，而不是调用一个模型 API 的 demo；
- 单租户、内部工具、自托管场景，愿意自己维护依赖、部署与升级。

**不适合**

- 想要开箱即用的托管服务或成品 SaaS；
- 需要多租户隔离、配额计费与 SLA 的生产业务 —— 当前没有这些保障，也没有压测与长稳数据；
- 不打算读代码、只想改几个环境变量就上线的场景。

## 当前能力

| 方向 | 现在有什么 | 前提 / 现状 |
| --- | --- | --- |
| **AI 应用开发** | 会话 / 运行 / 时间线落库；SSE 断线续传与服务重启恢复；上下文压缩；工具面装配；文件、技能库、记忆；工作区隔离；逐轮与网关用量；后台 AI 管理页与会话工作台 | 本地链路跑通；需要自己准备模型供应商 key 并在后台配置 |
| **可观测性** | 日志、指标与环比、告警（file / lark / email 通道）、探针、AI 工具审计，后台对应监控页 | 通知通道要按需配置；没有长期生产数据 |
| **设计与组件** | 一套 token 双前端共用、暗色主题、基础组件与 AI 组件、`check:ui` 守漂移 | 组件仍在演进，接口可能调整 |
| **工程约束** | 数据结构一份（Zod schema）、依赖单向、类型化 SDK、`DbService` 统一数据入口、守卫检查 | 守卫只能拦明显越界，不替代代码评审 |

## 现状与限制

- **成熟度**：个人维护的工程骨架，MIT 提供，没有 SLA 与版本承诺；接口、表结构、配置项都可能随开发调整。
- **验证到什么程度**：有 lint、格式化、四道守卫、全量 typecheck 与单元测试；**仓库里没有 e2e 测试与压测脚本**，
  SSE 透传、页面交互、Docker / k8s 部署按人工步骤验证过，没有长稳与并发数据。
- **生产路径未验证**：compose 与 k8s 清单齐备，但没有真实集群长期运行的记录；多副本、容量、
  故障演练、审计留存都需要自己补。
- **依赖外部条件**：对话需要模型供应商 key（仓库不含）；bash / 文件能力需要工作区镜像，Docker 路径
  还要先构建本机基础镜像；对象存储、飞书、邮件、Kafka 未配置就不可用。
- **安全边界取决于部署**：工作区隔离靠容器 / Pod / 沙箱；`AGENT_WORKSPACE_SANDBOX=false` 时命令直接
  以服务进程身份执行，只适合自托管单机。默认管理员 `admin@billy.local / admin123` 只用于本地开发，
  上线必须改。
- **文档里的清单会过期**：能力、组件、迁移这类清单是某个时点的快照，以代码和文档里的链接为准。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | pnpm 12 + Turbo | monorepo 依赖管理 + 按拓扑任务编排 |
| 服务端 | NestJS 12（Express 5） | 六个进程：main 9989（公网 API / 控制面）/ agent-runtime 9990（agent loop）/ model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995；通用能力归 `@repo/kits` |
| 数据 | PostgreSQL + TypeORM | 装饰器实体 + Repository / QueryBuilder，实体与迁移同一份字段（唯一来源 `@repo/db`） |
| 缓存 / 消息 | Redis（PubSub / EventBus / RedisStore） | 缓存 / 锁 / 会话 / 运行中进度 / 跨实例广播；Kafka 仅按需装配（`KAFKA_BROKERS` 存在时），当前没有业务生产 / 消费方 |
| 实时 | SSE（StreamHub + HttpStreamClient）+ Redis pub/sub | AI 流式 = runtime 发布 `agent:stream:client:<clientId>`（AG-UI 帧）→ main 订阅写 SSE；任务进度 / 通知走 StreamHub |
| AI 运行时 | Mastra + AI SDK 7 | agent 执行、工具调用、流式交给框架；工具注册机 / 落库 / 恢复 / 审计留在本工程 |
| 模型网关 | model-gateway | canonical OpenAI 协议 + openai-compatible / deepseek / ollama / anthropic 适配、模型目录、上游 key 池、用量落库；runtime 不持供应商 key |
| 能力平面 | capability-gateway + `@repo/capability` | 服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 限流校验 / MCP client；执行在 common-capability 与 workspace-service |
| 工作区隔离 | workspace-service + kits 的 workspace 模块 | 工作区生命周期（ensure / stop / destroy / status / exec / fs）、docker / k8s 容器驱动、空闲回收；本地沙箱由 `WorkspaceRuntimeService` 提供 |
| 前端 | Next.js 16 App Router + React 19 | RSC + SSR + Server Actions，前台与后台同构 |
| UI | Base UI + shadcn/ui + Tailwind 4 | 无样式原语 + 可定制组件；token 与主题收在 `@repo/ui` |
| 后台 | @repo/ui + TanStack Query / Table / Form + Zustand | DataTable / ModalForm / DataList 有现成封装 |
| 校验 | Zod | 共享 schema 同时派生 TypeScript 类型 |
| 日志 / 指标 | 自建 pino logger + Telemetry | 唯一 pino 实例，开发美化、生产 JSON / Loki；指标窗口聚合 |
| 存储 | S3 / COS | 预签名 URL + STS 临时凭证 |
| 产物 | tsdown | 后端包产出 dts；`@repo/ui` 直接用源码 |
| 部署 | Docker multi-stage + Kubernetes | compose 编排 6 个 Nest 服务 + 2 个前端 + 依赖 + 一次性 migrate（Kafka 可选）；k8s 清单覆盖 6 个 Deployment；`pnpm start:stack` 一次起 8 个应用 |

选型理由与同类项目对比见 [docs/billy-pitch.md](docs/billy-pitch.md) 第 7 节（观点性文档，不作为本文档的事实来源）。

## 服务与端口

| 服务 | 目录 / 包名 | 端口 | 对外 | 职责 |
| --- | --- | --- | --- | --- |
| Web 前台 | `apps/web`（`@app/web`） | 9840（Docker 3001） | 是 | 落地页 / 账号 / Markdown 示例 |
| Admin 后台 | `apps/admin`（`@app/admin`） | 9845（compose 宿主映射 9846） | 是 | 控制台 / 监控 / 用户 / AI 管理 / 免授权分享页 |
| **main（公网 API / 控制面）** | `apps/main`（`@app/main`） | **9989** | **是** | 鉴权 + 业务控制面 CRUD + 全部 AI 配置 / 管理 HTTP + `/agent/*`（含流式入口与 SSE 中继）；不跑 agent loop |
| **agent-runtime** | `apps/agent-runtime`（`@app/agent-runtime`） | **9990** | 否（只给 main 调） | 只跑 agent loop：agents / 会话编排 / 工具面装配 / 提示词 / 技能加载 / 子 agent / run 队列 / 恢复；只暴露 `/internal/agent/*` 与探针 |
| **model-gateway** | `apps/model-gateway`（`@app/model-gateway`） | **9992** | 内网 | 内部模型网关：canonical OpenAI 协议、多套上游协议适配、模型目录、上游 key 池、用量落库；runtime 不持供应商 key |
| **capability-gateway** | `apps/capability-gateway`（`@app/capability-gateway`） | **9993** | 内网 | 能力目录权威：服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 限流与校验 / MCP client / `ai_tool_audit` / 内建 `wait-task` `cancel-task` `tool-search`；不执行能力 |
| **common-capability** | `apps/common-capability`（`@app/common-capability`） | **9994** | 内网 | 通用能力执行：登记服务 `common`，提供 memory / web / `read-tool-result` / `file-submit` / `file-download` 等能力 |
| **workspace-service** | `apps/workspace-service`（`@app/workspace-service`） | **9995** | 内网 | 工作区执行面：工作区生命周期、docker / k8s 容器驱动、空闲回收；登记服务 `workspace`，提供 bash 与工作区文件能力 |

**前端只连 main（9989）**。runtime 不直接对外，main 鉴权后带上内部 token 与身份头调用它；四个内网服务
同样只走内网 HTTP + 内部 token（`AGENT_INTERNAL_TOKEN` / `MODEL_INTERNAL_TOKEN` + `MODEL_GATEWAY_TOKEN` /
`TOOL_INTERNAL_TOKEN` / `WORKSPACE_INTERNAL_TOKEN`），前端与外部系统都不需要知道它们的存在。

AI 流式**不依赖 Kafka**：runtime 把输出帧发布到 Redis pub/sub 频道 `agent:stream:client:<clientId>`，
main 的 `AgentSseBridge` 订阅后写回浏览器 SSE，断线按 `sinceRev` 从 Redis 输出记录补发（见
[后端](docs/guide/backend.md)）。Kafka 只在 `KAFKA_BROKERS` 存在时装配，当前没有业务生产 / 消费方。

## 快速开始

### 让 AI 帮你启动（把下面整段发给 agent）

> 下面这段从 clone 开始，发给任意有终端权限的编码 agent 即可；它不需要事先了解 billy-cli。

```text
你接手一个之前没接触过的仓库：billy-cli，当前机器上还没有它。目标：把它 clone 下来，在这台机器上把
开发环境跑起来，并如实汇报。不要改业务代码，不要提交，不要推送。

它是什么：NestJS 12 + TypeScript 7 + Next.js 16 的 pnpm monorepo（Turbo 编排）。6 个 Nest 服务
（main 9989 公网 API / agent-runtime 9990 / model-gateway 9992 / capability-gateway 9993 /
common-capability 9994 / workspace-service 9995）+ 两个 Next 前端（web 9840 / admin 9845）。
前端只连 main，其余服务只在内网互调。卡住时先读 README 的「快速开始」与 docs/guide/env.md；
仓库的 AGENTS.md 是开发准则，这次只启动，不要按它去改代码。

成功标准（缺一不算完成）：
1) 六个 Nest 服务端口都在监听；
2) POST http://localhost:9989/config/get 返回 JSON；
3) http://localhost:9840 能打开；admin 9845 可选，登录 admin@billy.local / admin123（bootstrap 默认创建）。
AI 对话还需要模型 key（第 5 步），bash / 文件能力还需要工作区镜像；这两项不属于「启动成功」，
但要在汇报里说明是否验证过。

按顺序做：

1. Clone（机器上还没有这个仓库时）：
   cd ~                      # 或用户指定的工作目录
   git clone https://github.com/Rihel/billy-cli.git
   cd billy-cli
   - 没有 git：停下来告诉用户需要先装 git。
   - clone 失败（网络 / 权限）：把原始报错贴给用户，不要改用其它来源的代码；SSH 方式可用
     git@github.com:Rihel/billy-cli.git。
   - 已经 clone 过：跳过本步，直接进仓库目录。
   确认目录是仓库根：能看到 package.json、pnpm-workspace.yaml、apps/、packages/。

2. 检查环境（缺什么先报告，不要擅自装系统级软件）：
   node -v        # 要求 >= 26
   pnpm -v        # 要求 >= 12；仓库 packageManager 会让 pnpm 自动切到 12.18，允许它下载
   docker info    # 看 Docker 是否可用；不可用记下来，第 3 步走无 Docker 分支
   版本不够就停下，告诉用户当前版本与仓库要求、给出安装命令，等确认。

3. 初始化（一条命令：装依赖 → 生成八份 .env → 构建 packages → 迁移 → 种子 → 冒烟）：
   pnpm bootstrap
   全新克隆会先自动 pnpm install，再逐步询问；想全默认用 pnpm bootstrap -y。
   - 没有 Docker：用 pnpm bootstrap --skip-docker，并先确认本机 PostgreSQL / Redis 可用
     （连接信息见 apps/main/.env 的 DB_URL / REDIS_URL；MinIO 可选）。
   - Docker 在但第 3 步失败：先 docker info 看 daemon，再 docker compose up -d postgres redis minio 后重试。
   - 迁移报 "Cannot find module @repo/.../dist"：说明 packages 没构建，先 pnpm build:pkgs 再继续。
   已存在的 .env 脚本会保留，不要删改；缺失的会从 .env.example 生成。

4. 启动（都是长驻进程，分别放后台或独立终端；不要串成一条命令，也不要等它自己退出）：
   pnpm dev:pkgs      # 必须先起：watch 构建 packages，dist 由它产出
   pnpm dev:stack     # 六个 Nest 服务
   pnpm dev:web       # 9840
   pnpm dev:admin     # 可选：9845
   先检查这些端口是否已经在监听：已在跑就复用，不要重复启动；端口被占且不是本项目的进程时先问用户，
   不要直接 kill。

5. 配置模型（AI 对话需要；不配也能启动）：
   apps/main/.env 的 MASTRA_API_KEY 默认是空的。让用户提供 key，或告诉用户启动后在 Admin「模型管理」
   里配置供应商与模型。没配好之前，不要说 AI 对话可用。

6. 验证并记录：
   curl -sS -X POST http://localhost:9989/config/get     # 期望 JSON
   curl -sS http://localhost:9840 | head                 # 期望 HTML
   各服务启动日志里不应出现 ConfigValidationError / ERR_MODULE_NOT_FOUND / ECONNREFUSED。
   工作区能力（可选）：需要 Docker 与镜像 billy-workspace:2026.11.1
   （docker build -f docker/Dockerfile.workspace-image -t billy-workspace:2026.11.1 docker），不构建就注明未验证。

7. 汇报（用事实说话）：
   - 实际在跑的服务 / 端口 / 进程；
   - 每条失败命令的原始错误、已尝试的修复、是否绕过；
   - 哪些能力已验证、哪些没验证（例如模型对话、bash、文件）；
   - 下一步用户做什么（填 key、访问地址、登录账号）。
   没成功就说没成功，不要用「应该可以」代替结果，不要编造日志或返回码。

约束：
- 不改业务代码、不提交、不推送；不 git checkout / stash / reset（仓库里可能有别人的改动）。
- 不 clone 到已有非空目录、不覆盖已有文件；目标目录已存在先问用户。
- 不删数据库或卷、不执行 docker compose down -v、不 kill 非本项目进程；这类操作先问。
- 不用 headless 浏览器（Playwright / Puppeteer / Chrome 截图）验证界面，界面交给用户看。
- 收尾如需停服务：pnpm kill:dev（先 --dry-run 看会停什么）。
```

### 前置条件

| 依赖 | 要求 |
| --- | --- |
| Node.js | ≥ 26（推荐 26.13；仓库根目录 `.nvmrc` 固定 26.13.0） |
| pnpm | ≥ 12（推荐 12.18；Node 26 不再内置 corepack，用 `npm i -g pnpm@12.18.0` 安装） |
| Docker（推荐） | `pnpm bootstrap` 默认用它起 PostgreSQL / Redis / MinIO；不用 Docker 时自备这三个依赖并加 `--skip-docker` |
| PostgreSQL / Redis | 必需，本机或 Docker；Redis 在启动时连接，未就绪会导致服务启动失败 |
| MinIO / S3 / COS | 可选，仅对象存储相关功能需要；未配置或服务不可达时服务照常启动，用到存储的接口才报错 |

### 初始化

```bash
pnpm bootstrap
```

一条命令完成：**安装依赖 → 环境检查 → Docker 依赖服务 → 生成八份 `.env`（main / agent-runtime /
model-gateway / capability-gateway / common-capability / workspace-service / admin / web）→
构建 packages → 数据库迁移 → 管理员种子 → 冒烟验证**。

入口是 `scripts/bootstrap.mjs`：全新克隆没有 `node_modules`，而引导脚本本身跑在 `tsx` 上，
所以第一层会先执行 `pnpm install`，再交给 `scripts/setup.ts`。`model-gateway` / `workspace-service`
的 `.env` 由 bootstrap 一并生成，数据库地址自动与 main 对齐。
交互式逐步确认，`pnpm bootstrap -y` 全默认（适合 CI / 脚本）；`--skip-docker|install|build|migrate|seed|smoke`
可跳过指定步骤。

> **首次使用 AI 前**：`apps/main/.env` 的 `MASTRA_API_KEY` 默认留空，需要填一个模型供应商密钥
> （或在 Admin 后台「模型管理」里配置），否则界面能登录但对话没有可用模型。
> 需要 AI 执行 bash / 读写工作区文件时，还要有 Docker 守护进程与 `billy-workspace` 镜像（构建命令见「生产构建」）。

不想用脚本也可以手动：`pnpm install` → `pnpm build:pkgs` → 按 `.env.example` 填配置（逐项说明见
[环境变量指南](docs/guide/env.md)）→ `pnpm db:migrate`（见 [部署文档](docs/guide/deployment.md)）。

### 启动开发环境

```bash
# 终端 1：并行 watch 构建 packages（shared / kits / contracts / internal-sdk / http-client / sdk 等）
pnpm dev:pkgs

# 终端 2：六个 Nest 服务一起起
pnpm dev:stack    # main 9989 / agent-runtime 9990 / model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995

# 也可以分开起（改哪边看哪边的日志）
pnpm dev:main              # 公网 API / 控制面，9989
pnpm dev:runtime           # agent loop，9990
pnpm dev:model-gateway     # 模型网关，9992
pnpm dev:tools             # capability-gateway 9993 + common-capability 9994 + workspace-service 9995

# 终端 3：Web 前台
pnpm dev:web      # http://localhost:9840

# 终端 4（可选）：Admin 后台
pnpm dev:admin    # http://localhost:9845
```

> `packages/*` 的运行时入口是构建产物 `dist/`（已被 gitignore）。`dev:stack` 之前必须先起
> `dev:pkgs`（watch 构建）或先跑一次 `pnpm build:pkgs`，否则服务会报 `Cannot find module @repo/.../dist`。
>
> **流式对话只依赖 Redis**：runtime 把 AG-UI 帧发布到 Redis pub/sub 频道
> `agent:stream:client:<clientId>`，main 订阅后写回前端 SSE；断线重连按 `sinceRev` 从 Redis
> 输出记录补发。Kafka 只在 `KAFKA_BROKERS` 存在时装配、当前没有业务生产 / 消费方，
> 起不起都不影响对话与非流式接口。

默认管理员：`admin@billy.local / admin123`（可用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖；也可单独执行 `pnpm seed:admin`）。

### 生产构建

```bash
pnpm build           # 全量（8 个应用 + 全部 packages）；也可 build:web / build:admin / build:main / build:runtime / build:model-gateway / build:pkgs
pnpm start:stack     # 一次起 8 个应用：6 个 Nest 服务（9989 / 9990 / 9992 / 9993 / 9994 / 9995）+ admin 9845 + web 9840
pnpm start:main      # 公网 API / 控制面：9989
pnpm start:runtime   # agent loop：9990（只给 main 调）
pnpm start:model-gateway     # 模型网关：9992
pnpm start:capability-gateway # 能力网关：9993
pnpm start:common-capability  # 通用能力执行：9994
pnpm start:web       # standalone，默认 9840（与 dev 一致；Docker 内为 3001）
pnpm start:admin     # standalone，默认 9845（可选）
# 或 Docker Compose（postgres + redis + minio + migrate + 6 个 Nest 服务 + web + admin）
pnpm docker:up
```

首次用 Docker Compose 时，先补齐两个前置：

```bash
./build-base-image.sh        # 六个 Nest / 前端镜像都 FROM 本机基础镜像 node26-pnpm12:1.0
pnpm bootstrap --skip-smoke  # 生成八份 .env；compose 的 main / agent-runtime 用 env_file 挂载
```

> Compose 已按 6 个 Nest 服务 + 2 个前端的形态编排：main 与 agent-runtime 共享 DB / Redis /
> `AGENT_INTERNAL_TOKEN`，四个内网服务只在容器网络内互调（model-gateway / capability-gateway /
> common-capability / workspace-service 不映射宿主机端口），web 只连 `http://main:9989`。
> 工作区执行镜像单独构建：`docker build -f docker/Dockerfile.workspace-image -t billy-workspace:2026.11.1 docker`；
> compose 里的 workspace-service 挂 `docker.sock` 并以容器驱动拉起工作区。Kafka 仍是可选 profile（默认不起）。

环境变量逐项说明见 [环境变量指南](docs/guide/env.md)，镜像、Kubernetes 与反向代理细节见 [部署文档](docs/guide/deployment.md)。

## 项目结构

```text
├── apps/
│   ├── main/           公网 API / 控制面：auth / user / admin / session / storage / share / monitor / ops / config
│   │                   + 全部 AI CRUD + /agent 入口与 SSE 中继（9989）
│   ├── agent-runtime/  只跑 agent loop（Mastra / 工具面装配 / 提示词 / 技能 / 子 agent / run 队列 / 恢复），
│   │                   只暴露 /internal/agent/* 与探针（9990，不对外）
│   ├── model-gateway/  模型网关：canonical OpenAI 接口 + openai-compatible/deepseek/ollama/anthropic 适配
│   │                   + 模型目录 + 上游 key 池 + 用量落库（9992，不对外）
│   ├── capability-gateway/   能力目录权威：服务登记 / 心跳 / 授权 / 路由 / 限流校验 / MCP client / 审计（9993，不执行能力）
│   ├── common-capability/    通用能力执行：memory / web / read-tool-result / 文件收发（9994）
│   ├── workspace-service/    工作区执行面：bash + 工作区文件能力，容器 / Pod 生命周期与空闲回收（9995）
│   ├── web/            Next.js 16 前台：落地页 / 账号 / Markdown 示例（9840）
│   └── admin/          Next.js 16 管理后台：控制台 / 监控 / 用户 / AI / 免授权分享页（9845）
├── packages/
│   ├── shared/    Zod schema 与字典、错误码、日志工厂、文件类型判定、通用工具（前后端共享）
│   ├── kits/      后端通用能力：Db / Redis / PubSub / EventBus / Stream / JWT / 会话 / 存储 / 调度 / 通知 / 限流 / 工作区 / Kafka / 横切 HTTP 构件
│   ├── db/        TypeORM 实体与迁移的唯一来源，DB_ENTITIES / DB_MIGRATIONS 供各服务装配
│   ├── monitor/   监控引擎：指标采集 / 规则评估 / 告警 / 通知（main 与 agent-runtime 装配）
│   ├── ai-data/   AI 数据能力（FileService / MemoryService / 工具结果分页 / 用量，main / runtime / worker 共用）
│   ├── contracts/     跨 app 契约（capability / tool / workspace / registry / model-gateway 的 Zod schema）
│   ├── internal-sdk/  内部服务 typed client（能力网关 / 工作区 / 模型网关 / runtime）
│   ├── web-runtime/   出网 / SSRF 校验 / HTML→Markdown / 按行分页 / 反爬识别（runtime、main、common-capability 共用）
│   ├── capability/    能力声明机制：@CapabilityGroup / @CapabilityDecl / scanCapabilities / 登记
│   ├── http-client/  通用 HTTP + 鉴权管线（策略 / 凭证 / SSE 客户端）
│   ├── sdk/       ServerClient：全类型化业务 API，构建在 http-client 之上
│   └── ui/        Base UI + shadcn 基础组件、ai-elements、设计系统
├── docker/        Dockerfile.base + 6 个 Nest 服务镜像 + .web / .admin + .workspace-image + init-db.sql
├── k8s/           6 个 Nest 服务的 Kubernetes 清单（Namespace / ConfigMap / Deployment / Service / PDB / HPA / Ingress + PVC / RBAC）
├── docs/          指南（guide/）、设计文档（design/）、开发日志（dev-logs/）+ 专题（pagination / queue / sdk-refactor / billy-pitch）
└── scripts/       bootstrap（入口 mjs + setup.ts 引导）/ kill-dev / kill-ports / check-* 守卫 + commit-msg 校验 / start-standalone / clean / codegraph 初始化
```

完整目录树与分层规则见 [架构文档](docs/guide/architecture.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构与项目结构](docs/guide/architecture.md) | 完整目录、分层与数据流、六个 Nest 服务的组合根与生命周期、分页与 `DbService` |
| [后端](docs/guide/backend.md) | `apps/main`（HTTP 边界 / 鉴权 / 控制面）+ `apps/agent-runtime`（agent loop）+ 四个内网服务（模型网关 / 能力网关 / 通用能力 / 工作区执行面）；流式与 PubSub、业务模块、错误格式、日志、监控告警 |
| [前端](docs/guide/frontend.md) | Web / Admin 页面、设计系统、组件库与管理端组件 |
| [共享包](docs/guide/packages.md) | 逐个说明：`@repo/shared`、`@repo/kits`、`@repo/db`、`@repo/monitor`、`@repo/ai-data`、`@repo/contracts`、`@repo/internal-sdk`、`@repo/web-runtime`、`@repo/capability`、`@repo/http-client`、`@repo/sdk`、`@repo/ui` |
| [AI 能力](docs/guide/ai.md) | 六个 Nest 服务的分工、工具面、能力目录与 MCP、工作区隔离、文件管理、技能库、记忆、模型与网关用量、Agent Skills |
| [环境变量](docs/guide/env.md) | 8 个 app 的环境变量逐项说明：默认值 / 必填性 / 读取位置 / 已移除项与核对方式 |
| [部署](docs/guide/deployment.md) | 环境变量口径、生产构建、Docker、Kubernetes、反向代理 |
| [工程化](docs/guide/engineering.md) | 命令、工具链版本、lint / 格式化 / 钩子、校验与守卫 |
| [设计文档](docs/design/) | 每个能力的方案与取舍（AI、能力协议与网关、工作区、模型网关、SSE、监控、设计系统…），按主题索引 |
| [开发日志](docs/dev-logs/) | 按日记录每轮改动的背景 / 做了什么 / 验证 |
| [竞品调研](docs/billy-pitch.md) | 项目定位、同类模板对比、技术选型理由 |
| [Agent Skills](.agents/skills/README.md) | 工程 skill 目录：分层、代码约定、各功能开发规范 |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 一键初始化：装依赖 → 依赖服务 → 八份 `.env` → 构建 packages → 迁移 → 种子 → 冒烟（`-y` 非交互，`--skip-*` 跳过指定步骤） |
| `pnpm seed:admin` | 创建首个管理员（由 `@app/main` 执行） |
| `pnpm dev:pkgs` / `pnpm build:pkgs` | watch 构建 / 构建全部 packages |
| `pnpm dev:stack` | 一次起 6 个 Nest 服务：main 9989 / agent-runtime 9990 / model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995 |
| `pnpm dev:main` / `pnpm dev:runtime` / `pnpm dev:model-gateway` | 单独起公网 API / 控制面（9989）/ agent loop（9990）/ 模型网关（9992）；`dev:server` 是 `dev:main` 的别名 |
| `pnpm dev:tools` | 起工具侧三件套：capability-gateway 9993 + common-capability 9994 + workspace-service 9995 |
| `pnpm dev:capability-gateway` / `pnpm dev:common-capability` / `pnpm dev:workspace-service` | 单独起某个内网服务 |
| `pnpm dev:web` / `pnpm dev:admin` | 启动前台（9840）/ 后台（9845） |
| `pnpm build` | 全量构建（8 个应用 + 全部 packages） |
| `pnpm build:web` / `pnpm build:admin` / `pnpm build:main` / `pnpm build:runtime` / `pnpm build:model-gateway` | 构建单个应用（含其依赖包）；capability-gateway / common-capability / workspace-service 没有专用 alias，用 `pnpm --filter @app/<name> build` |
| `pnpm start:stack` | 一次起 8 个应用（6 个 Nest 服务 + web + admin） |
| `pnpm start:main` / `pnpm start:runtime` / `pnpm start:model-gateway` / `pnpm start:capability-gateway` / `pnpm start:common-capability` / `pnpm start:workspace-service` / `pnpm start:web` / `pnpm start:admin` | 生产启动（需先构建对应应用）；`start:server` 是 `start:main` 的别名 |
| `pnpm kill:dev` | 停掉全部 dev 服务（`--dry-run` 仅预览） |
| `pnpm kill:start` | 按端口停生产进程（默认 9840 / 9845 / 9989 / 9990 / 9992 / 9993 / 9994 / 9995 共 8 个，`--dry-run` 预览） |
| `pnpm kill:tools` / `pnpm kill:port <端口>` | 停 9992~9995 内网服务 / 停指定端口 |
| `pnpm kill:all` | `kill:dev` + `kill:start` |
| `pnpm verify` | lint + 类型感知 lint + 格式化检查 + 四道守卫（`check:inject` / `check:mastra` / `check:redis-raw` / `check:ui`） |
| `pnpm typecheck` / `pnpm test` | 全量类型检查 / 单元测试 |
| `pnpm check:inject` | 构造器 `@Inject` / providers `@Injectable` 一致性 |
| `pnpm check:mastra` | Mastra 适配器边界（只有 runtime 的适配层可 import `@mastra/*`） |
| `pnpm check:redis-raw` | 业务 app 不得直接调 `redis.raw`，统一走 `RedisStore` 封装的方法 |
| `pnpm check:ui` | 前端 5 条不变量：组件导出 / 前端包脚本 / 硬编码颜色 / 样式入口 / 字体变量 |
| `pnpm lint` / `pnpm lint:fix` / `pnpm lint:types` | oxlint / 自动修复 / 类型感知 lint |
| `pnpm fmt` / `pnpm fmt:check` | oxfmt 格式化 / 只检查 |
| `pnpm db:gen <name>` / `pnpm db:migrate` | 生成 / 执行 TypeORM 迁移（CLI 归属 `@repo/db`，DataSource 在 `packages/db/data-source.ts`） |
| `pnpm db:backfill-subconversations` | 回填历史子会话（一次性脚本，挂在 `@app/agent-runtime`） |
| `pnpm hooks:install` | 安装 lefthook Git 钩子（`pnpm install` 已自动执行） |
| `pnpm docker:up` | Docker Compose 起全套（migrate + 6 个 Nest 服务 + web + admin + 依赖） |
| `pnpm codegraph:setup` | 初始化 codegraph 代码图谱（可选，AI 开发增强） |
| `pnpm clean` | 清理 node_modules / dist / 缓存 |

## 部署

```bash
docker compose up -d postgres redis minio   # 仅基础设施
./build-base-image.sh                       # 首次：构建本机基础镜像（所有服务镜像的 FROM）
pnpm bootstrap --skip-smoke                 # 首次：生成八份 .env（compose 的 main / agent-runtime 用 env_file）
pnpm docker:up                              # 全部（migrate + 6 个 Nest 服务 + admin + web + 依赖）
docker compose --profile kafka up -d        # 可选：追加 Kafka（当前无业务生产 / 消费方，不影响流式）
```

- 镜像：`docker/Dockerfile.base` + 六个 Nest 服务各一份（`.main` / `.agent-runtime` / `.model-gateway` / `.capability-gateway` / `.common-capability` / `.workspace-service`）+ `.web` / `.admin`，以及被管工作区镜像 `docker/Dockerfile.workspace-image`（python 3.13 + node 26 + pnpm，工作目录 `/workspace`）
- **服务形态**：compose 与 k8s 都按「6 个 Nest 服务 + 2 个前端」编排；只有 main（9989）、web、admin 暴露端口，runtime 与四个内网服务只在网络内互调（compose 给 admin 映射宿主 9846、web 映射 3001）。compose 含一次性 `migrate`；workspace-service 挂 `docker.sock` 以容器驱动拉起工作区（k8s 用 PVC + ServiceAccount/Role 走 Pod 驱动）。字段与跨文件不变量见 [k8s/README.md](k8s/README.md)
- `Dockerfile.web` 与 compose 的 `web` 服务只构建前台；后台 `apps/admin` 同构构建、独立部署
  （免授权分享页 `/s/{token}` 挂在 admin，生产要分享就必须部署它）
- 前置网关：keep-alive 递增、SSE 关缓冲、限流信任代理，三处易踩的坑见 [部署文档](docs/guide/deployment.md)

## 参与贡献

1. 先读 [AGENTS.md](AGENTS.md)（工程首要准则）与 [`billy-dev-foundation`](.agents/skills/billy-dev-foundation/SKILL.md)（分层、代码约定、标准流程）。
2. `pnpm install` 会自动装好 Git 钩子（lefthook）：commit 时自动格式化 + lint 修复，push 前跑 `verify` + `typecheck`。
3. 提交前跑：`pnpm verify`（lint / 类型感知 / 格式化检查 / 四道守卫）、`pnpm typecheck`、`pnpm test`。
4. 提交信息使用中文类型前缀（`新增：…`），钩子会校验；规则见 [`git-workflow`](.agents/skills/git-workflow/SKILL.md)。
5. 工程化细则（规则取舍、Windows、跳过钩子）见 [工程化指南](docs/guide/engineering.md)。
6. 改能力时同步 README、落地页与受影响的文档 / skill。

欢迎 Issue 与 PR。

## 许可

MIT © 2026 Rihel，见 [LICENSE](LICENSE)。
