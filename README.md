# Billy

[![Node](https://img.shields.io/badge/node-%E2%89%A526-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-12-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![NestJS](https://img.shields.io/badge/NestJS-12-e0234e?logo=nestjs&logoColor=white)](https://nestjs.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Rihel/billy-cli?style=social)](https://github.com/Rihel/billy-cli)

> **开箱即用的 AI 应用开发基座** —— 会话、流式、工具面、能力服务、模型网关、工作区隔离与审计的运行时
> 已经在仓库里，可观测性、设计系统与分层约束一并开箱。
>
> 基于 **NestJS 12 + TypeScript 7 + Next.js 16** 的全栈 Monorepo（pnpm + Turbo）：
> 后端按「控制面 / 执行面 / 内网服务」拆成 6 个 Nest 进程 —— main（公网 BFF）+ agent-runtime（agent loop）
> + model-gateway / capability-gateway / common-capability / workspace-service（只在内网互调），
> 通用能力收在 `@repo/kits`；前端 Web 与 Admin 两套独立入口，共用 `@repo/ui` 与 Tailwind 4。

GitHub：[Rihel/billy-cli](https://github.com/Rihel/billy-cli)

## 为什么是 Billy

- **AI 能力是产品，不是演示**：会话 / 运行 / 时间线三张表落库，SSE 断线续传（按 `sinceRev` 从
  Redis 输出记录补发）、服务重启恢复、上下文压缩、逐轮用量与工具审计都已跑通，
  不是接一个模型 API 再画个聊天框。
- **接外部系统不用发版**：执行侧写一个 `@CapabilityDecl` 并登记到能力网关，就产出一组受管能力；
  网关统一目录、授权（能力 key 或服务级授权）、限流、校验、路由与审计。外部系统按 MCP（HTTP）
  登记进来即可被 `tool-search` 发现。旧的「连接器」适配层已删除（2026-11-18），
  外部系统不再需要逐个发版接。
- **执行在隔离环境里**：`bash` 与工作区文件能力由 workspace-service 在工作区里执行（容器 / k8s Pod /
  本地沙箱），三档文件权限由部署的 `AGENT_WORKSPACE_SANDBOX` 与容器后端决定，沙箱不可用时 fail closed。
- **出事不用登服务器**：`requestId` 串起日志、指标、告警与 AI 运行，后台五个监控页直接看。
- **改一处处处对得上**：数据结构一份（Zod schema）派生实体 / 接口类型 / 表单 / 列表；依赖方向单向，
  九道检查拦住走样；28 个 Agent Skills 指向仓库真实文件，AI 改代码时读到的就是这套约束。

## 能力一览

| 方向 | 已具备 |
| --- | --- |
| **AI 应用开发** | 35 个工具面 key（本地编排 15 · 能力服务 17 · 网关内建 3）· 能力目录 20 个 code 能力 + MCP 外部服务 · 会话 / 运行 / 时间线落库 · 流式续传 · 崩溃恢复 · 上下文压缩 · 文件 / 技能库 / 记忆 · 工作区隔离 · 逐轮与网关用量 · 后台 10 个 AI 管理页 + 会话工作台 + 技能编辑器 |
| **可观测性** | 日志 · 指标（含环比）· 告警（file / lark / email 通道）· 探针 · AI 工具审计（`ai_tool_audit`），后台 5 个监控页 |
| **设计与组件** | 61 个基础组件 · 48 个 ai-elements · 一套 token 双前端共用 · 暗色主题 · `check:ui` 守漂移 |
| **工程约束** | 数据结构一份 · 依赖单向 · 全类型 SDK · `DbService` 统一数据入口 · 九道检查 |

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | pnpm 12 + Turbo | monorepo 依赖管理 + 按拓扑任务编排 |
| 服务端 | NestJS 12（Express 5） | 六个进程：main 9989（公网 BFF）/ agent-runtime 9990（agent loop）/ model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995；通用能力归 `@repo/kits` |
| 数据 | PostgreSQL + TypeORM | 26 个实体 / 38 个迁移，装饰器实体 + Repository / QueryBuilder，实体与迁移同一份字段（唯一来源 `@repo/db`） |
| 缓存 / 消息 | Redis（PubSub / EventBus / RedisStore） | 缓存 / 锁 / 会话 / 运行中进度 / 跨实例广播；Kafka 仅按需装配（`KAFKA_BROKERS` 存在时），当前没有业务生产 / 消费方 |
| 实时 | SSE（StreamHub + HttpStreamClient）+ Redis pub/sub | AI 流式 = runtime 发布 `agent:stream:client:<clientId>`（AG-UI 帧）→ main 订阅写 SSE；任务进度 / 通知走 StreamHub |
| AI 运行时 | Mastra + AI SDK 7 | agent 执行、工具调用、流式交给框架；工具注册机 / 落库 / 恢复 / 审计留在本工程 |
| 模型网关 | model-gateway | canonical OpenAI 协议 + openai-compatible / deepseek / ollama / anthropic 适配、模型目录、上游 key 池、用量落库；runtime 不持供应商 key |
| 能力平面 | capability-gateway + `@repo/capability` | 服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 限流校验 / MCP client；执行在 common-capability 与 workspace-service |
| 工作区隔离 | workspace-service + kits 的 workspace 模块 | 工作区生命周期（ensure / stop / destroy / status / exec / fs）、docker / k8s 容器驱动、空闲回收；本地沙箱由 `WorkspaceRuntimeService` 提供 |
| 前端 | Next.js 16 App Router + React 19 | RSC + SSR + Server Actions，前台与后台同构 |
| UI | Base UI + shadcn/ui + Tailwind 4 | 无样式原语 + 可定制组件；token 与主题收在 `@repo/ui` |
| 后台 | @repo/ui + TanStack Query / Table / Form + Zustand | DataTable / ModalForm / DataList 开箱即用 |
| 校验 | Zod | 共享 schema 同时派生 TypeScript 类型 |
| 日志 / 指标 | 自建 pino logger + Telemetry | 唯一 pino 实例，开发美化、生产 JSON / Loki；指标窗口聚合 |
| 存储 | S3 / COS | 预签名 URL + STS 临时凭证 |
| 产物 | tsdown | 11 个后端包产出 dts；`@repo/ui` 直接用源码 |
| 部署 | Docker multi-stage + Kubernetes | compose 15 个服务（6 个 Nest 服务 + 2 个前端 + 依赖 + 一次性 migrate + 可选 Kafka 三件套）、10 个 Dockerfile（含工作区镜像）、k8s 24 个 YAML 清单；`pnpm start:stack` 一次起 8 个应用 |

选型理由见 [docs/billy-pitch.md](docs/billy-pitch.md) 第 7 节。

## 服务与端口

| 服务 | 目录 / 包名 | 端口 | 对外 | 职责 |
| --- | --- | --- | --- | --- |
| Web 前台 | `apps/web`（`@app/web`） | 9840（Docker 3001） | 是 | 落地页 / 账号 / Markdown 示例 |
| Admin 后台 | `apps/admin`（`@app/admin`） | 9845（compose 宿主映射 9846） | 是 | 控制台 / 监控 / 用户 / AI 管理 / 免授权分享页 |
| **main（公网 BFF）** | `apps/main`（`@app/main`） | **9989** | **是** | 鉴权 + 业务控制面 CRUD + 全部 AI 配置 / 管理 HTTP + `/agent/*`（含流式入口与 SSE 中继）；不跑 agent loop |
| **agent-runtime** | `apps/agent-runtime`（`@app/agent-runtime`） | **9990** | 否（只给 main 调） | 只跑 agent loop：agents / 会话编排 / 工具面装配 / 提示词 / 技能加载 / 子 agent / run 队列 / 恢复；只暴露 `/internal/agent/*` 与探针 |
| **model-gateway** | `apps/model-gateway`（`@app/model-gateway`） | **9992** | 内网 | 内部模型网关：canonical OpenAI 协议、4 套上游协议适配、模型目录、上游 key 池、用量落库；runtime 不持供应商 key |
| **capability-gateway** | `apps/capability-gateway`（`@app/capability-gateway`） | **9993** | 内网 | 能力目录权威：服务登记 / 心跳 / 能力目录 / 授权过滤 / 调用路由 / 限流与校验 / MCP client / `ai_tool_audit` / 内建 `wait-task` `cancel-task` `tool-search`；不执行能力 |
| **common-capability** | `apps/common-capability`（`@app/common-capability`） | **9994** | 内网 | 通用能力执行：登记服务 `common`，9 个能力（memory 三件套 / web 三件套 / `read-tool-result` / `file-submit` / `file-download`） |
| **workspace-service** | `apps/workspace-service`（`@app/workspace-service`） | **9995** | 内网 | 工作区执行面：工作区生命周期、docker / k8s 容器驱动、空闲回收；登记服务 `workspace`，8 个能力（bash + 工作区文件） |

**前端只连 main（9989）**。runtime 不直接对外，main 鉴权后带上内部 token 与身份头调用它；四个内网服务
同样只走内网 HTTP + 内部 token（`AGENT_INTERNAL_TOKEN` / `MODEL_INTERNAL_TOKEN` + `MODEL_GATEWAY_TOKEN` /
`TOOL_INTERNAL_TOKEN` / `WORKSPACE_INTERNAL_TOKEN`），前端与外部系统都不需要知道它们的存在。

AI 流式**不依赖 Kafka**：runtime 把输出帧发布到 Redis pub/sub 频道 `agent:stream:client:<clientId>`，
main 的 `AgentSseBridge` 订阅后写回浏览器 SSE，断线按 `sinceRev` 从 Redis 输出记录补发（见
[后端](docs/guide/backend.md)）。Kafka 只在 `KAFKA_BROKERS` 存在时装配，当前没有业务生产 / 消费方。

## 快速开始

### 前置条件

| 依赖 | 要求 |
| --- | --- |
| Node.js | ≥ 26（推荐 26.13） |
| pnpm | ≥ 12（推荐 12.18；Node 26 不再内置 corepack） |
| PostgreSQL / Redis | 本机或 Docker；Redis 在启动时连接，未就绪会导致服务启动失败 |
| MinIO / S3 / COS | 可选，仅对象存储相关功能需要；未配置或服务不可达时服务照常启动，用到存储的接口才报错 |

### 初始化

```bash
pnpm bootstrap
```

一条命令完成：环境检查 → Docker 依赖服务 → 生成六份 `.env`（main / agent-runtime / capability-gateway / common-capability / admin / web）→ 安装依赖 → 迁移 → 管理员种子 → 冒烟验证。
交互式逐步确认，`pnpm bootstrap -y` 全默认（适合 CI / 脚本）。`model-gateway` / `workspace-service`
读各自的 `apps/<app>/.env`（模板见 `.env.example`），首次联调按模板复制并保持数据库地址与 main 一致。

不想用脚本也可以手动：`pnpm install` → 按 `.env.example` 填配置（逐项说明见 [环境变量指南](docs/guide/env.md)）→ `pnpm db:migrate`（见 [部署文档](docs/guide/deployment.md)）。

### 启动开发环境

```bash
# 终端 1：并行 watch 构建 packages（shared / kits / contracts / internal-sdk / http-client / sdk 等 8 个包）
pnpm dev:pkgs

# 终端 2：六个 Nest 服务一起起
pnpm dev:stack    # main 9989 / agent-runtime 9990 / model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995

# 也可以分开起（改哪边看哪边的日志）
pnpm dev:main              # 公网 BFF，9989
pnpm dev:runtime           # agent loop，9990
pnpm dev:model-gateway     # 模型网关，9992
pnpm dev:tools             # capability-gateway 9993 + common-capability 9994 + workspace-service 9995

# 终端 3：Web 前台
pnpm dev:web      # http://localhost:9840

# 终端 4（可选）：Admin 后台
pnpm dev:admin    # http://localhost:9845
```

> **流式对话只依赖 Redis**：runtime 把 AG-UI 帧发布到 Redis pub/sub 频道
> `agent:stream:client:<clientId>`，main 订阅后写回前端 SSE；断线重连按 `sinceRev` 从 Redis
> 输出记录补发。Kafka 只在 `KAFKA_BROKERS` 存在时装配、当前没有业务生产 / 消费方，
> 起不起都不影响对话与非流式接口。

默认管理员：`admin@billy.local / admin123`（可用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖；也可单独执行 `pnpm seed:admin`）。

### 生产构建

```bash
pnpm build           # 全量（8 个应用 + 全部 packages）；也可 build:web / build:admin / build:main / build:runtime / build:model-gateway / build:pkgs
pnpm start:stack     # 一次起 8 个应用：6 个 Nest 服务（9989 / 9990 / 9992 / 9993 / 9994 / 9995）+ admin 9845 + web 9840
pnpm start:main      # 公网 BFF：9989
pnpm start:runtime   # agent loop：9990（只给 main 调）
pnpm start:model-gateway     # 模型网关：9992
pnpm start:capability-gateway # 能力网关：9993
pnpm start:common-capability  # 通用能力执行：9994
pnpm start:web       # standalone，默认 9840（与 dev 一致；Docker 内为 3001）
pnpm start:admin     # standalone，默认 9845（可选）
# 或 Docker Compose（postgres + redis + minio + migrate + 6 个 Nest 服务 + web + admin）
pnpm docker:up
```

> Compose 已按 6 个 Nest 服务 + 2 个前端的形态编排：main 与 agent-runtime 共享 DB / Redis /
> `AGENT_INTERNAL_TOKEN`，四个内网服务只在容器网络内互调（model-gateway / capability-gateway /
> common-capability / workspace-service 不映射宿主机端口），web 只连 `http://main:9989`。
> 工作区执行镜像单独构建：`docker build -f docker/Dockerfile.workspace-image -t billy-workspace:2026.11.0 docker`；
> compose 里的 workspace-service 挂 `docker.sock` 并以容器驱动拉起工作区。Kafka 仍是可选 profile（默认不起）。

环境变量逐项说明见 [环境变量指南](docs/guide/env.md)，镜像、Kubernetes 与反向代理细节见 [部署文档](docs/guide/deployment.md)。

## 项目结构

```text
├── apps/
│   ├── main/           公网 BFF：auth / user / admin / session / storage / share / monitor / ops / config
│   │                   + 全部 AI CRUD + /agent 入口与 SSE 中继（9989）
│   ├── agent-runtime/  只跑 agent loop（Mastra / 工具面装配 / 提示词 / 技能 / 子 agent / run 队列 / 恢复），
│   │                   只暴露 /internal/agent/* 与探针（9990，不对外）
│   ├── model-gateway/  模型网关：canonical OpenAI 接口 + openai-compatible/deepseek/ollama/anthropic 适配
│   │                   + 模型目录 + 上游 key 池 + 用量落库（9992，不对外）
│   ├── capability-gateway/   能力目录权威：服务登记 / 心跳 / 授权 / 路由 / 限流校验 / MCP client / 审计（9993，不执行能力）
│   ├── common-capability/    通用能力执行：memory / web / read-tool-result / 文件收发共 9 个能力（9994）
│   ├── workspace-service/    工作区执行面：bash + 工作区文件 8 个能力，容器 / Pod 生命周期与空闲回收（9995）
│   ├── web/            Next.js 16 前台：落地页 / 账号 / Markdown 示例（9840）
│   └── admin/          Next.js 16 管理后台：控制台 / 监控 / 用户 / AI / 免授权分享页（9845）
├── packages/
│   ├── shared/    Zod schema（23 个）与字典（11 个）、错误码、日志工厂、文件类型判定、通用工具（前后端共享）
│   ├── kits/      后端通用能力：17 个能力目录 / 23 个模块（Db / Redis / PubSub / EventBus / Stream / JWT / 会话 / 存储 / 调度 / 通知 / 限流 / 工作区 / Kafka / 横切 HTTP 构件）
│   ├── db/        TypeORM 实体（26 个）+ 迁移（38 个）唯一来源，DB_ENTITIES / DB_MIGRATIONS 供各服务装配
│   ├── monitor/   监控引擎：指标采集 / 规则评估 / 告警 / 通知（main 与 agent-runtime 装配）
│   ├── ai-data/   AI 数据能力（FileService / MemoryService / 工具结果分页 / 用量，main / runtime / worker 共用）
│   ├── contracts/     跨 app 契约（capability / tool / workspace / registry / model-gateway 的 Zod schema）
│   ├── internal-sdk/  内部服务 typed client（能力网关 / 工作区 / 模型网关 / runtime）
│   ├── web-runtime/   出网 / SSRF 校验 / HTML→Markdown / 按行分页 / 反爬识别（runtime、main、common-capability 共用）
│   ├── capability/    能力声明机制：@CapabilityGroup / @CapabilityDecl / scanCapabilities / 登记
│   ├── http-client/  通用 HTTP + 鉴权管线（策略 / 凭证 / SSE 客户端）
│   ├── sdk/       ServerClient：全类型化业务 API，构建在 http-client 之上
│   └── ui/        Base UI + shadcn 组件（61 个）、ai-elements（48 个）、设计系统
├── docker/        Dockerfile.base + 6 个 Nest 服务镜像 + .web / .admin + .workspace-image + init-db.sql
├── k8s/           6 个 Nest 服务的 Kubernetes 清单（Namespace / ConfigMap / Deployment / Service / PDB / HPA / Ingress + PVC / RBAC）
├── docs/          指南（guide/）、设计文档（design/）、开发日志（dev-logs/）+ 专题（pagination / queue / sdk-refactor / billy-pitch）
└── scripts/       bootstrap / kill-dev / kill-ports / check-* 守卫（4 道 + commit-msg 校验）/ start-standalone / clean / codegraph 初始化
```

完整目录树与分层规则见 [架构文档](docs/guide/architecture.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构与项目结构](docs/guide/architecture.md) | 完整目录、分层与数据流、六个 Nest 服务的组合根与生命周期、分页与 `DbService` |
| [后端](docs/guide/backend.md) | `apps/main`（HTTP 边界 / 鉴权 / 控制面）+ `apps/agent-runtime`（agent loop）+ 四个内网服务（模型网关 / 能力网关 / 通用能力 / 工作区执行面）；流式与 PubSub、业务模块、错误格式、日志、监控告警 |
| [前端](docs/guide/frontend.md) | Web / Admin 页面、设计系统、组件库与管理端组件 |
| [共享包](docs/guide/packages.md) | 12 个包逐个：`@repo/shared`、`@repo/kits`、`@repo/db`、`@repo/monitor`、`@repo/ai-data`、`@repo/contracts`、`@repo/internal-sdk`、`@repo/web-runtime`、`@repo/capability`、`@repo/http-client`、`@repo/sdk`、`@repo/ui` |
| [AI 能力](docs/guide/ai.md) | 六个 Nest 服务的分工、工具面（35 个 key）、能力目录与 MCP、工作区隔离、文件管理、技能库、记忆、模型与网关用量、Agent Skills |
| [环境变量](docs/guide/env.md) | 8 个 app 的环境变量逐项说明：默认值 / 必填性 / 读取位置 / 已移除项与核对方式 |
| [部署](docs/guide/deployment.md) | 环境变量口径、生产构建、Docker、Kubernetes、反向代理 |
| [工程化](docs/guide/engineering.md) | 命令、工具链版本、lint / 格式化 / 钩子、九道检查 |
| [设计文档](docs/design/) | 每个能力的方案与取舍（AI、能力协议与网关、工作区、模型网关、SSE、监控、设计系统…），按主题索引 |
| [开发日志](docs/dev-logs/) | 按日记录每轮改动的背景 / 做了什么 / 验证 |
| [竞品调研](docs/billy-pitch.md) | 项目定位、同类模板对比、技术选型理由 |
| [Agent Skills](.agents/skills/README.md) | 28 个工程 skill：分层、代码约定、各功能开发规范 |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 一键初始化（`-y` 非交互，`--skip-*` 跳过指定步骤） |
| `pnpm seed:admin` | 创建首个管理员（由 `@app/main` 执行） |
| `pnpm dev:pkgs` / `pnpm build:pkgs` | watch 构建 / 构建全部 packages |
| `pnpm dev:stack` | 一次起 6 个 Nest 服务：main 9989 / agent-runtime 9990 / model-gateway 9992 / capability-gateway 9993 / common-capability 9994 / workspace-service 9995 |
| `pnpm dev:main` / `pnpm dev:runtime` / `pnpm dev:model-gateway` | 单独起公网 BFF（9989）/ agent loop（9990）/ 模型网关（9992）；`dev:server` 是 `dev:main` 的别名 |
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
| `pnpm verify` | lint + 类型感知 lint + 格式化检查 + 4 道守卫（`check:inject` / `check:mastra` / `check:redis-raw` / `check:ui`），共 7 项 |
| `pnpm typecheck` / `pnpm test` | 全量类型检查 / 单元测试（与 `verify` 合计九道检查） |
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
3. 提交前跑：`pnpm verify`（lint / 类型感知 / 格式化检查 / 四道守卫）、`pnpm typecheck`、`pnpm test`，合计九道检查。
4. 提交信息使用中文类型前缀（`新增：…`），钩子会校验；规则见 [`git-workflow`](.agents/skills/git-workflow/SKILL.md)。
5. 工程化细则（规则取舍、Windows、跳过钩子）见 [工程化指南](docs/guide/engineering.md)。
6. 改能力时同步 README、落地页与受影响的文档 / skill。

欢迎 Issue 与 PR。

## 许可

MIT © 2026 Rihel，见 [LICENSE](LICENSE)。
