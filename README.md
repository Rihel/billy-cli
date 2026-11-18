# Billy

[![Node](https://img.shields.io/badge/node-%E2%89%A526-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-12-f69220?logo=pnpm&logoColor=white)](https://pnpm.io)
[![NestJS](https://img.shields.io/badge/NestJS-12-e0234e?logo=nestjs&logoColor=white)](https://nestjs.com)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Rihel/billy-cli?style=social)](https://github.com/Rihel/billy-cli)

> **开箱即用的 AI 应用开发基座** —— 会话、流式、工具、连接器、模型、审计的运行时已经在仓库里，
> 可观测性、设计系统与分层约束一并开箱。
>
> 基于 **NestJS 12 + TypeScript 7 + Next.js 16** 的全栈 Monorepo（pnpm + Turbo）：
> 后端是「NestJS 薄边界 + 业务模块」，通用能力收在 `@repo/kits`；前端 Web 与 Admin 两套独立入口，
> 共用 `@repo/ui` 与 Tailwind 4。

GitHub：[Rihel/billy-cli](https://github.com/Rihel/billy-cli)

## 为什么是 Billy

- **AI 能力是产品，不是演示**：会话 / 运行 / 时间线三张表落库，SSE 断线续传、服务重启恢复、
  上下文压缩、逐轮用量与审计都已跑通，不是接一个模型 API 再画个聊天框。
- **接外部系统不用发版**：连接器在后台加一条数据，就产出一组受管工具（PostgreSQL / MySQL / Redis / 飞书 CLI），
  开关、限额、审计与内建工具走同一套网关。
- **出事不用登服务器**：`requestId` 串起日志、指标、告警与 AI 运行，后台五个监控页直接看。
- **改一处处处对得上**：数据结构一份（Zod schema）派生实体 / 接口类型 / 表单 / 列表；依赖方向单向，
  八道检查拦住走样；28 个 Agent Skills 指向仓库真实文件，AI 改代码时读到的就是这套约束。

## 能力一览

| 方向 | 已具备 |
| --- | --- |
| **AI 应用开发** | 29 个内建工具（另 3 个运行时自带）· 4 类连接器 · 会话 / 运行 / 时间线落库 · 流式续传 · 崩溃恢复 · 上下文压缩 · 文件 / 技能库 / 记忆 · 逐轮用量审计 · 后台 8 个 AI 页 |
| **可观测性** | 日志 · 指标（含环比）· 四类告警 · 探针 · AI 审计，后台 5 个监控页 |
| **设计与组件** | 61 个基础组件 · 48 个 ai-elements · 一套 token 双前端共用 · 暗色主题 · `check:ui` 守漂移 |
| **工程约束** | 数据结构一份 · 依赖单向 · 全类型 SDK · `DbService` 统一数据入口 · 八道检查 |

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | pnpm 12 + Turbo | monorepo 依赖管理 + 按拓扑任务编排 |
| 服务端 | NestJS 12（Express 5） | 两个进程：`apps/main` 公网 BFF（9989）+ `apps/agent-runtime` agent loop（9990），通用能力归 `@repo/kits` |
| 数据 | PostgreSQL + TypeORM | 装饰器实体 + Repository / QueryBuilder，实体与迁移同一份字段 |
| 缓存 / 消息 | Redis（PubSub / EventBus）+ Kafka | 缓存 / 锁 / 会话 / 运行中进度 / SSE 跨实例广播；Kafka 按需装配 |
| 实时 | SSE（StreamHub + HttpStreamClient）+ Kafka | AI 流式 = runtime → Kafka `agent.run.events` → main 的 SSE；任务进度 / 通知走 StreamHub + Redis pub/sub 跨实例 |
| AI 运行时 | Mastra + AI SDK 7 | agent 执行、工具调用、流式交给框架；网关 / 落库 / 恢复 / 审计留在本工程 |
| AI 连接器 | 数据库 / Redis / 飞书 CLI | 后台加一行数据就产出工具，连接、凭证、限额、审计统一管理 |
| 前端 | Next.js 16 App Router + React 19 | RSC + SSR + Server Actions，前台与后台同构 |
| UI | Base UI + shadcn/ui + Tailwind 4 | 无样式原语 + 可定制组件；token 与主题收在 `@repo/ui` |
| 后台 | @repo/ui + TanStack Query / Table / Form + Zustand | DataTable / ModalForm / DataList 开箱即用 |
| 校验 | Zod | 共享 schema 同时派生 TypeScript 类型 |
| 日志 / 指标 | 自建 pino logger + Telemetry | 唯一 pino 实例，开发美化、生产 JSON / Loki；指标窗口聚合 |
| 存储 | S3 / COS | 预签名 URL + STS 临时凭证 |
| 产物 | tsdown | shared / kits / http-client / sdk 产出 dts；`@repo/ui` 直接用源码 |
| 部署 | Docker multi-stage + Kubernetes | compose 起依赖与 web；镜像按 main / runtime 拆分的改造进行中，附 k8s 清单 |

选型理由见 [docs/billy-pitch.md](docs/billy-pitch.md) 第 7 节。

## 服务与端口

| 服务 | 目录 / 包名 | 端口 | 对外 | 职责 |
| --- | --- | --- | --- | --- |
| Web 前台 | `apps/web`（`@app/web`） | 9840 | 是 | 落地页 / 账号 / Markdown 示例 |
| Admin 后台 | `apps/admin`（`@app/admin`） | 9845 | 是 | 控制台 / 监控 / 用户 / AI / 免授权分享页 |
| **main（公网 BFF）** | `apps/main`（`@app/main`） | **9989** | **是** | 鉴权、用户 / 管理员 / 会话 / 存储 / 分享 / 监控 / 运维 / 配置、全部 AI 配置与 CRUD（模型 / 工具 / 技能 / 连接器 / 记忆 / 会话 / 运行 / 时间线 / 用量）、`/agent/chat/stream` 的 Kafka→SSE 中继 |
| **agent-runtime** | `apps/agent-runtime`（`@app/agent-runtime`） | **9990** | 否（只给 main 调） | 只跑 agent loop：Mastra / 上下文 / 工具面 / 记忆 / 技能加载 / 子 agent / run 状态机；只暴露 `/internal/agent/*` 与 `/healthz` 等运维探针，没有 public controller 与鉴权 |
| capability-gateway | `apps/capability-gateway`（`@app/capability-gateway`） | 9993 | 内网 | 工具目录 / 策略（enabled / scope / 限流 / 校验）/ worker 路由 / `ai_tool_audit`，不执行工具 |
| common-capability | `apps/common-capability`（`@app/common-capability`） | 9994 | 内网 | 工具执行（bash / web / file / memory 等），按能力注册到 Redis，沙箱执行 |

**前端只连 main（9989）**。runtime 不直接对外，main 鉴权后带上内部 token 与身份头调用它；
runtime 的模型输出写到 Kafka `agent.run.events`，main 消费后按 `clientId` 写回前端 SSE。
因此本地要跑通「流式对话」，Kafka 必须起（`docker compose --profile kafka up -d` + 建 topic），
否则 runtime 不发事件、main 的 SSE 会空等（见 [后端](docs/guide/backend.md)）。

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

一条命令完成：环境检查 → Docker 依赖服务 → 生成四份 `.env`（main / agent-runtime / admin / web）→ 安装依赖 → 迁移 → 管理员种子 → 冒烟验证。
交互式逐步确认，`pnpm bootstrap -y` 全默认（适合 CI / 脚本）。

不想用脚本也可以手动：`pnpm install` → 按 `.env.example` 填配置 → `pnpm db:migrate`（见 [部署文档](docs/guide/deployment.md)）。

### 启动开发环境

```bash
# 终端 1：并行 watch 构建 packages（shared / kits / http-client / sdk）
pnpm dev:pkgs

# 终端 2：main + agent-runtime + capability-gateway + common-capability 一起起
pnpm dev:stack    # main http://localhost:9989 / runtime 9990 / gateway 9993 / worker 9994

# 也可以分开起（改哪边看哪边的日志）
pnpm dev:main     # 公网 BFF，9989
pnpm dev:runtime  # agent loop，9990
pnpm dev:tools    # capability-gateway 9993 + common-capability 9994

# 终端 3：Web 前台
pnpm dev:web      # http://localhost:9840

# 终端 4（可选）：Admin 后台
pnpm dev:admin    # http://localhost:9845
```

> **流式对话需要 Kafka**：runtime 的模型输出经 `agent.run.events`（实际 topic `app.agent.run.events`，
> 前缀由 `KAFKA_TOPIC_PREFIX` 决定）回 main 的 SSE，Kafka 没起时对话请求会建立连接但收不到内容。
> 先 `docker compose --profile kafka up -d`，再执行 `scripts/kafka-create-topics.sh`
> （3 分区、key=runId）；非流式接口（会话 / 文件 / 配置等）不依赖 Kafka。

默认管理员：`admin@billy.local / admin123`（可用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖；也可单独执行 `pnpm seed:admin`）。

### 生产构建

```bash
pnpm build           # 全量（也可单独 pnpm build:web / build:admin / build:main / build:runtime，含依赖包）
pnpm start:main      # 公网 BFF：9989
pnpm start:runtime   # agent loop：9990（需先 build:runtime；只给 main 调）
pnpm start:web       # standalone，默认 9840（与 dev 一致；Docker 内为 3001）
pnpm start:admin     # standalone，默认 9845（可选）
# 或 Docker Compose（postgres + redis + minio + main + agent-runtime + web）
pnpm docker:up
```

> Compose 已按拆分后的形态编排：main 与 agent-runtime 共享 DB / Redis / `AGENT_INTERNAL_TOKEN`，
> runtime 只在容器网络内用 9990，web 只连 `http://main:9989`。Kafka 仍是可选 profile，
> 但「流式对话」必须启用它。

环境变量、镜像、Kubernetes 与反向代理细节见 [部署文档](docs/guide/deployment.md)。

## 项目结构

```text
├── apps/
│   ├── main/           公网 BFF：auth / user / admin / session / storage / share / monitor / ops / config
│   │                   + 全部 AI CRUD + /agent 的 Kafka→SSE 中继（9989）
│   ├── agent-runtime/  只跑 agent loop（Mastra / 工具面 / 记忆 / 技能 / 子 agent / 恢复），
│   │                   只暴露 /internal/agent/* 与探针（9990，不对外）
│   ├── model-gateway/  内部模型网关：canonical OpenAI 接口 + openai/deepseek/ollama 协议适配 + 模型目录（9992，不对外）
│   ├── capability-gateway/   工具目录 / 策略 / worker 路由 / 审计（9993，不执行工具）
│   ├── common-capability/    工具执行 + 能力自注册（9994）
│   ├── web/            Next.js 16 前台：落地页 / 账号 / Markdown 示例（9840）
│   └── admin/          Next.js 16 管理后台：控制台 / 监控 / 用户 / AI / 免授权分享页（9845）
├── packages/
│   ├── shared/    Zod schema、错误码字典、日志工厂、文件类型判定、通用工具（前后端共享）
│   ├── kits/      后端通用能力：Db / Redis / PubSub / EventBus / Stream / JWT / 会话 / 存储 / 调度 / 通知 / 限流 / 工作区 / Kafka / 横切 HTTP 构件
│   ├── db/        TypeORM 实体 + 迁移（唯一来源，两个 Nest 应用共用）
│   ├── monitor/   监控引擎：指标采集 / 规则评估 / 告警 / 通知（main 与 runtime 各装配一份）
│   ├── ai-data/   AI 数据能力（FileService / MemoryService 等，main 与 worker 共用）
│   ├── contracts/     内部服务契约（Zod schema，跨 app 共用）
│   ├── internal-sdk/  内部服务 typed client（capability-gateway / worker / runtime）
│   ├── web-runtime/   bash / web / 文件工具的共享执行实现
│   ├── http-client/  通用 HTTP + 鉴权管线（策略 / 凭证 / SSE 客户端）
│   ├── sdk/       ServerClient：全类型化业务 API，构建在 http-client 之上
│   └── ui/        Base UI + shadcn 组件、ai-elements、设计系统
├── docker/        Dockerfile.base / .main / .agent-runtime / .web + init-db.sql
├── k8s/           main + agent-runtime 的 Kubernetes 清单与部署说明
├── docs/          指南（guide/）、设计文档（design/）、开发日志（dev-logs/）、调研快照（research/）
└── scripts/       bootstrap / kill-dev / 检查脚本 / kafka 建 topic / codegraph 初始化
```

完整目录树与分层规则见 [架构文档](docs/guide/architecture.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构与项目结构](docs/guide/architecture.md) | 完整目录、分层与数据流、组合根与生命周期、分页与 `DbService` |
| [后端](docs/guide/backend.md) | `apps/main`（HTTP 边界 / 鉴权 / API）+ `apps/agent-runtime`（agent loop / Kafka SSE），业务模块、错误格式、日志、监控告警 |
| [前端](docs/guide/frontend.md) | Web / Admin 页面、设计系统、组件库与管理端组件 |
| [共享包](docs/guide/packages.md) | `@repo/shared`、`@repo/kits`、`@repo/db`、`@repo/web-runtime`、`@repo/http-client`、`@repo/sdk` |
| [AI 能力](docs/guide/ai.md) | 运行时与接口、工具与连接器、文件管理、技能库、记忆、工作区隔离、Agent Skills、AI 使用配置（codegraph） |
| [部署](docs/guide/deployment.md) | 环境变量、生产构建、Docker、Kubernetes、反向代理 |
| [设计文档](docs/design/) | 每个能力的方案与取舍（AI、SSE、监控、设计系统、连接器…），按主题索引 |
| [开发日志](docs/dev-logs/) | 按日记录每轮改动的背景 / 做了什么 / 验证 |
| [调研快照](docs/research/) | AI SDK / AI Elements 的版本化调研报告（记录写作时的版本，不代表当前实现） |
| [竞品调研](docs/billy-pitch.md) | 项目定位、同类模板对比、技术选型理由 |
| [Agent Skills](.agents/skills/README.md) | 28 个工程 skill：分层、代码约定、各功能开发规范 |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 一键初始化（`-y` 非交互） |
| `pnpm dev:pkgs` / `pnpm build:pkgs` | watch 构建 / 构建 packages |
| `pnpm dev:stack` | 一条命令起 main（9989）+ runtime（9990）+ gateway（9993）+ worker（9994） |
| `pnpm dev:main` / `pnpm dev:runtime` / `pnpm dev:model-gateway` | 单独起公网 BFF（9989）/ agent loop（9990）/ 模型网关（9992） |
| `pnpm dev:tools` / `pnpm dev:capability-gateway` / `pnpm dev:common-capability` | 起工具侧（两个 / 单个） |
| `pnpm dev:web` / `pnpm dev:admin` | 启动前台（9840）/ 后台（9845） |
| `pnpm kill:dev` | 停掉全部 dev 服务（`--dry-run` 仅预览） |
| `pnpm kill:start` / `pnpm kill:port <端口>` | 跨平台按端口停进程（默认 9840 / 9845 / 9989 / 9990 / 9993 / 9994，`--dry-run` 预览） |
| `pnpm build` / `pnpm build:web` / `pnpm build:admin` / `pnpm build:main` / `pnpm build:runtime` | 全量构建 / 单个应用构建（含其依赖包） |
| `pnpm start:main` / `pnpm start:runtime` / `pnpm start:web` / `pnpm start:admin` | 生产启动（9989 / 9990 / 9840 / 9845；Docker 内 web 为 3001） |
| `pnpm typecheck` / `pnpm test` | 全量类型检查 / 单元测试 |
| `pnpm verify && pnpm turbo run typecheck test` | 全套检查（lint / fmt / 守卫 + 类型 + 测试）；turbo 只缓存后两项 |
| `pnpm check:inject` | 构造器 `@Inject` / providers `@Injectable` 一致性 |
| `pnpm check:mastra` | Mastra 适配器边界（只有 runtime 可 import `@mastra/*`） |
| `pnpm check:ui` | 组件导出 / 前端包脚本 / 硬编码颜色 / 设计系统规范 |
| `pnpm db:gen <name>` / `pnpm db:migrate` | 生成 / 执行 TypeORM 迁移（根脚本指向 `@repo/db`；seed admin 由 `@app/main` 执行） |
| `pnpm seed:admin` | 创建首个管理员 |
| `pnpm docker:up` | Docker Compose 起全套（main + agent-runtime + web + 依赖） |
| `pnpm codegraph:setup` | 初始化 codegraph 代码图谱（可选，AI 开发增强） |
| `pnpm clean` | 清理 node_modules / dist / 缓存 |

## 部署

```bash
docker compose up -d postgres redis minio   # 仅基础设施
pnpm docker:up                              # 全部（migrate + main + agent-runtime + gateway + worker + web）
docker compose --profile kafka up -d        # 可选：追加 Kafka（生产流式对话建议启用）
```

- 镜像：`docker/Dockerfile.base` / `.main` / `.agent-runtime` / `.capability-gateway` / `.common-capability` / `.web`；`lark-cli` 只装在 agent-runtime 镜像（连接器的命令行执行方），main 镜像不装
- **拆分状态（2026-11-14）**：compose 与 k8s 已按 main（9989）+ agent-runtime（9990）拆好；
  runtime / gateway / worker 都不透出公网端口，只由 main / runtime 内部调用；compose 已包含一次性
  `migrate`、gateway/worker、web 与 admin。Kafka 未配置时 main 降级为直接转发 runtime SSE。字段与跨文件不变量见 [k8s/README.md](k8s/README.md)
- `Dockerfile.web` 与 compose 的 `web` 服务只构建前台；后台 `apps/admin` 同构构建、独立部署
  （免授权分享页 `/s/{token}` 挂在 admin，生产要分享就必须部署它）
- 前置网关：keep-alive 递增、SSE 关缓冲、限流信任代理，三处易踩的坑见 [部署文档](docs/guide/deployment.md)

## 参与贡献

1. 先读 [AGENTS.md](AGENTS.md)（工程首要准则）与 [`billy-dev-foundation`](.agents/skills/billy-dev-foundation/SKILL.md)（分层、代码约定、标准流程）。
2. `pnpm install` 会自动装好 Git 钩子（lefthook）：commit 时自动格式化 + lint 修复，push 前跑 `verify` + `typecheck`。
3. 提交前跑：`pnpm verify`（lint / 类型感知 / 格式化检查 / 三道守卫）、`pnpm typecheck`、`pnpm test`。
4. 提交信息使用中文类型前缀（`新增：…`），钩子会校验；规则见 [`git-workflow`](.agents/skills/git-workflow/SKILL.md)。
5. 工程化细则（规则取舍、Windows、跳过钩子）见 [工程化指南](docs/guide/engineering.md)。
6. 改能力时同步 README、落地页与受影响的文档 / skill。

欢迎 Issue 与 PR。

## 许可

MIT © 2026 Rihel，见 [LICENSE](LICENSE)。
