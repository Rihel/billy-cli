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
  五道检查拦住走样；27 个 Agent Skills 指向仓库真实文件，AI 改代码时读到的就是这套约束。

## 能力一览

| 方向 | 已具备 |
| --- | --- |
| **AI 应用开发** | 10 个内建工具 · 4 类连接器 · 会话 / 运行 / 时间线落库 · 流式续传 · 崩溃恢复 · 上下文压缩 · 用量与审计 · 后台 5 页 |
| **可观测性** | 日志 · 指标（含环比）· 四类告警 · 探针 · AI 审计，后台 5 个监控页 |
| **设计与组件** | 61 个基础组件 · 48 个 ai-elements · 一套 token 双前端共用 · 暗色主题 · `check:ui` 守漂移 |
| **工程约束** | 数据结构一份 · 依赖单向 · 全类型 SDK · `DbService` 统一数据入口 · 五道检查 |

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 构建 | pnpm 12 + Turbo | monorepo 依赖管理 + 按拓扑任务编排 |
| 服务端 | NestJS 12（Express 5） | 模块化 HTTP 边界，业务模块归 `apps/server`，通用能力归 `@repo/kits` |
| 数据 | PostgreSQL + TypeORM | 装饰器实体 + Repository / QueryBuilder，实体与迁移同一份字段 |
| 缓存 / 消息 | Redis + Kafka | 缓存 / 锁 / 会话 / 运行中进度 / SSE 跨实例广播；Kafka 按需装配 |
| 实时 | SSE（StreamHub + HttpStreamClient） | AI 流式 / 任务进度 / 通知，Redis pub/sub 跨实例 |
| AI 运行时 | Mastra + AI SDK 7 | agent 执行、工具调用、流式交给框架；网关 / 落库 / 恢复 / 审计留在本工程 |
| AI 连接器 | 数据库 / Redis / 飞书 CLI | 后台加一行数据就产出工具，连接、凭证、限额、审计统一管理 |
| 前端 | Next.js 16 App Router + React 19 | RSC + SSR + Server Actions，前台与后台同构 |
| UI | Base UI + shadcn/ui + Tailwind 4 | 无样式原语 + 可定制组件；token 与主题收在 `@repo/ui` |
| 后台 | @repo/ui + TanStack Query / Table / Form + Zustand | DataTable / ModalForm / DataList 开箱即用 |
| 校验 | Zod | 共享 schema 同时派生 TypeScript 类型 |
| 日志 / 指标 | 自建 pino logger + Telemetry | 唯一 pino 实例，开发美化、生产 JSON / Loki；指标窗口聚合 |
| 存储 | S3 / COS | 预签名 URL + STS 临时凭证 |
| 产物 | tsdown | shared / kits / http-client / sdk 产出 dts；`@repo/ui` 直接用源码 |
| 部署 | Docker multi-stage + Kubernetes | server / web 独立镜像，compose 一键起依赖，附 k8s 清单 |

选型理由见 [docs/billy-pitch.md](docs/billy-pitch.md) 第 7 节。

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

一条命令完成：环境检查 → Docker 依赖服务 → 生成三份 `.env` → 安装依赖 → 迁移 → 管理员种子 → 冒烟验证。
交互式逐步确认，`pnpm bootstrap -y` 全默认（适合 CI / 脚本）。

不想用脚本也可以手动：`pnpm install` → 按 `.env.example` 填配置 → `pnpm db:migrate`（见 [部署文档](docs/guide/deployment.md)）。

### 启动开发环境

```bash
# 终端 1：并行 watch 构建 packages（shared / kits / http-client / sdk）
pnpm dev:pkgs

# 终端 2：NestJS API
pnpm dev:server   # http://localhost:9989

# 终端 3：Web 前台
pnpm dev:web      # http://localhost:9840

# 终端 4（可选）：Admin 后台
pnpm dev:admin    # http://localhost:9845
```

默认管理员：`admin@billy.local / admin123`（可用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 覆盖；也可单独执行 `pnpm seed:admin`）。

### 生产构建

```bash
pnpm build
pnpm start:server
pnpm start:web
# 或 Docker Compose（postgres + redis + minio + server + web）
pnpm docker:up
```

环境变量、镜像、Kubernetes 与反向代理细节见 [部署文档](docs/guide/deployment.md)。

## 项目结构

```text
├── apps/
│   ├── server/    NestJS 12 HTTP 边界 + 业务模块 + 组合根（9989）
│   ├── web/       Next.js 16 前台：落地页 / 账号 / Markdown 示例（9840）
│   └── admin/     Next.js 16 管理后台：控制台 / 监控 / 用户 / AI（9845）
├── packages/
│   ├── shared/    Zod schema、错误码字典、日志工厂、通用工具（前后端共享）
│   ├── kits/      后端通用能力：Db / Redis / JWT / 存储 / 消息 / 调度 / 推送 / 限流
│   ├── http-client/  通用 HTTP + 鉴权管线（策略 / 凭证 / SSE 客户端）
│   ├── sdk/       ServerClient：全类型化业务 API，构建在 http-client 之上
│   └── ui/        Base UI + shadcn 组件、ai-elements、设计系统
├── docker/        Dockerfile.base / .server / .web + init-db.sql
├── k8s/           server 的 Kubernetes 清单与部署说明
├── docs/          指南（guide/）、设计文档（design/）、开发日志（dev-logs/）
└── scripts/       bootstrap / kill-dev / 检查脚本 / codegraph 初始化
```

完整目录树与分层规则见 [架构文档](docs/guide/architecture.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [架构与项目结构](docs/guide/architecture.md) | 完整目录、分层与数据流、组合根与生命周期、分页与 `DbService` |
| [后端](docs/guide/backend.md) | `apps/server`、业务模块、认证、API 路由与错误格式、日志、监控告警 |
| [前端](docs/guide/frontend.md) | Web / Admin 页面、设计系统、组件库与管理端组件 |
| [共享包](docs/guide/packages.md) | `@repo/shared`、`@repo/kits`、`@repo/http-client`、`@repo/sdk` |
| [AI 能力](docs/guide/ai.md) | 运行时与接口、连接器、Agent Skills、AI 使用配置（codegraph） |
| [部署](docs/guide/deployment.md) | 环境变量、生产构建、Docker、Kubernetes、反向代理 |
| [设计文档](docs/design/) | 每个能力的方案与取舍（AI、SSE、监控、设计系统、连接器…），按主题索引 |
| [开发日志](docs/dev-logs/) | 按日记录每轮改动的背景 / 做了什么 / 验证 |
| [竞品调研](docs/billy-pitch.md) | 项目定位、同类模板对比、技术选型理由 |
| [Agent Skills](.agents/skills/README.md) | 27 个工程 skill：分层、代码约定、各功能开发规范 |

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm bootstrap` | 一键初始化（`-y` 非交互） |
| `pnpm dev:pkgs` / `pnpm build:pkgs` | watch 构建 / 构建 packages |
| `pnpm dev:server` | 启动 API（9989） |
| `pnpm dev:web` / `pnpm dev:admin` | 启动前台（9840）/ 后台（9845） |
| `pnpm kill:dev` | 停掉全部 dev 服务（`--dry-run` 仅预览） |
| `pnpm build` / `pnpm start:server` / `pnpm start:web` | 全量构建 / 生产启动 |
| `pnpm typecheck` / `pnpm test` | 全量类型检查 / 单元测试 |
| `pnpm check:inject` | 构造器 `@Inject` / providers `@Injectable` 一致性 |
| `pnpm check:mastra` | Mastra 适配器边界（业务不被框架渗透） |
| `pnpm check:ui` | 组件导出 / 前端包脚本 / 硬编码颜色 / 设计系统规范 |
| `pnpm db:gen <name>` / `pnpm db:migrate` | 生成 / 执行 TypeORM 迁移 |
| `pnpm seed:admin` | 创建首个管理员 |
| `pnpm docker:up` | Docker Compose 起全套 |
| `pnpm codegraph:setup` | 初始化 codegraph 代码图谱（可选，AI 开发增强） |
| `pnpm clean` | 清理 node_modules / dist / 缓存 |

## 部署

```bash
docker compose up -d postgres redis minio   # 仅基础设施
pnpm docker:up                              # 全部（含 server + web）
docker compose --profile kafka up -d        # 追加 Kafka（可选）
```

- 镜像：`docker/Dockerfile.base` / `.server` / `.web`；server 镜像预装官方 `lark-cli`
- Kubernetes：`k8s/` 清单与字段说明见 [k8s/README.md](k8s/README.md)
- 前置网关：keep-alive 递增、SSE 关缓冲、限流信任代理，三处易踩的坑见 [部署文档](docs/guide/deployment.md)

## 参与贡献

1. 先读 [AGENTS.md](AGENTS.md)（工程首要准则）与 [`billy-dev-foundation`](.agents/skills/billy-dev-foundation/SKILL.md)（分层、代码约定、标准流程）。
2. 提交前跑完五道检查：`pnpm typecheck`、`pnpm test`、`pnpm check:inject`、`pnpm check:mastra`、`pnpm check:ui`。
3. 提交信息使用中文类型前缀，规则见 [`git-workflow`](.agents/skills/git-workflow/SKILL.md)。
4. 改能力时同步 README、落地页与受影响的文档 / skill。

欢迎 Issue 与 PR。

## 许可

MIT © 2026 Rihel，见 [LICENSE](LICENSE)。
