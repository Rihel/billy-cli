# 设计文档

> 每篇回答「这个能力为什么长这样、当时取舍了什么」。使用与操作见 [../guide/](../guide/)；
> 哪天改的见 [../dev-logs/](../dev-logs/)。
>
> 最近一次与代码逐篇核对：**2026-11-14**（main / agent-runtime 拆分落地）。设计稿记录的是当时的方案与取舍，
> 其中「已归档 / 已废弃」的旧稿保留历史论证、不再代表现状；事实冲突时以代码与 guide 为准。
> 拆分前的设计稿里，`server` / `facade` 现在分别对应 `apps/main` / `apps/agent-runtime`；
> 实际链路与差异见 [distributed-ai-architecture.md](distributed-ai-architecture.md) 的「0.1 落地现状」。

## 架构

| 文档 | 内容 |
| --- | --- |
| [distributed-ai-architecture.md](distributed-ai-architecture.md) | AI 分布式架构升级（评审稿）：**0.1 落地现状（main/runtime/Kafka）** → 背景/目标 → 瓶颈 → 方案 → 决策 D1–D10（含 Mastra 边界、内部 SDK、子会话）→ 运行状态机 → 组件保活与心跳 → 流程 → 可观测与告警 → 容量 → 运行形态（本地/非 k8s/k8s）与服务发现→ 分期 → 待决 |
| [model-gateway.md](model-gateway.md) | **评审稿**：第 5 个服务 model-gateway（9992）——canonical 接口 / 流式转发 / 文件与生图产物 / 计量与成本 / key 池与配额 / 迁移与回退（§13 待拍板） |
| [async-subagent.md](async-subagent.md) | 异步子 agent 与会话 run 队列方案：run-sub-agent 异步化、用户优先队列、完成唤醒父 run、工具契约与分阶段实施 |
| [distributed-ai-conclusions.md](distributed-ai-conclusions.md) | 讨论结论一页版：已定 / 建议 / 待拍板，含工具边界、连接器、planner/ask/memory、子会话、迁移顺序与当前进度 |
| [capability-gateway.md](capability-gateway.md) | **评审稿**：能力网关重定义（服务登记 + 能力治理 + 能力路由）与按安全边界拆域服务——市面对标、被否掉的方案、12 条决策、三阶段迁移、7 项待拍板 |
| [capability-protocol.md](capability-protocol.md) | **草案**：内部能力接入协议 v1——`namespace/tool` 规范 key 与模型面映射、服务/能力/执行声明、sync 与 task 三形态、长耗时命令约定、回调、幂等分页凭据、32 工具新旧对照与别名迁移 |
| [resource-isolation.md](resource-isolation.md) | **暂缓（2026-11-19）**：资源隔离 v1（单用户）——主体/归属模型、五层防线、能力服务与凭据 P0、模型 Key、管理员支持模式、迁移与隔离测试矩阵；项目/成员/授权只留扩展点 |
| [service-authorization.md](service-authorization.md) | **设计稿（2026-11-19）**：服务级授权——仅外部服务/MCP 需授权、自建协议服务默认全量；`ai_service_grants` 表、默认值与迁移、网关过滤链路、授权接口与页面 |

## AI

| 文档 | 内容 |
| --- | --- |
| [ai-agent.md](ai-agent.md) | AI 运行时：会话 / 运行 / 流式 / 上下文 / 恢复 |
| [ai-file-manager.md](ai-file-manager.md) | AI 文件管理：会话级文件树 / 对象存储 / 提交与回读 / 前端预览下载 |
| [workspace-runtime.md](workspace-runtime.md) | 工作区运行时：命令隔离（默认强制、fail closed、会话只读/可写）与平台后端（历史论证，模型已由 workspace.md 取代） |
| [workspace.md](workspace.md) | **设计稿**：工作空间 = AI 执行环境（取代「会话级目录」模型）——概念模型 / Docker 加固 / 文件与持久化 / 能力作用方式 / MCP / 生命周期 / 迁移与验收 |
| [workspace-cli-credentials.md](workspace-cli-credentials.md) | **设计稿 v3（2026-11-20）**：工作区执行环境 + 技能归属与授权 + 个人凭据 + 后台菜单与数据权限——目标与非目标、资产三层、初始化阶段、`personal_credentials`（密文 / 类型 / 有效期 / 导入 / 同步）、技能分平台级与个人级及授权表、CLI 适配器、决策记录、风险、实施计划与验收 |
| [workspace-local-followups.md](workspace-local-followups.md) | **大白话（2026-11-22）**：本地工作区目录只有一个概念（没配用 `~/.billy/workspaces/<id>`、配了用给定路径）；**每节都有四模式对照表**（local 没配 / local 配了 / docker / k8s）——生命周期、一次 bash / 读 / 写、技能、凭据、安装清单、后台与接口、11 个能力、并发与多副本、会话绑定、安全边界、数据、报错、环境变量，另有总表和 7 个问题、4 件待定 |
| [workspace-env-contract.md](workspace-env-contract.md) | **草案（2026-11-22）**：工作区执行环境驱动抽象第一版——四层分工（能力 / 执行面 / 驱动 / 策略）、`WorkspaceEnvironment` + `EnvFeatures`、Host 与 Docker 两种驱动（K8s 暂不纳入）、Windows 必须支持且沙箱先忽略、Host 只搬技能不搬凭据与装包、沙箱开关改为 `AGENT_WORKSPACE_SANDBOX` 布尔、12 条一致性测试、P1–P3 落地顺序 |
| [workspace-preview.md](workspace-preview.md) | **设计稿（2026-11-23）**：工作区预览——每个工作区一个本地 `IP:端口` origin；静态 `serve` / NestJS 应用监听端口，浏览器直连，无子域名 / Kong；工作区页「预览」面板手动开启、默认关闭；无鉴权、容器 3000 / host 随机端口、进程生命周期、端口恢复、回收与 TTL、验收与风险 |
| [workspace-conversation-workdir.md](workspace-conversation-workdir.md) | **设计稿（2026-11-23，P0–P4 已实现）**：会话工作目录规范——每个会话 `conversations/<rootConversationId>/`，`bash` / 文件工具默认在此；`.agents` / `.billy` 共享在根；会话内 `public/`（预览）、`projects/`（新建 / clone）、`tmp/`（临时 / 下载）、`artifacts/`（交付）、`tmp/`（临时）、`uploads/`（入站）、`subagents/`（子 agent 结论）；可选 `shared/`；老会话 `workdir=null` 回落根、不搬文件；预览按会话根；影响面、验收、迁移与排期 |
| [ai-agent-tool-engine.md](ai-agent-tool-engine.md) | 工具引擎：工具组 / 注册机 / 网关插件 / 配置入库 |
| [ai-skill-library.md](ai-skill-library.md) | 技能库：在线编辑 / 链接导入（skills.sh、GitHub）/ 启停，DB 是事实源、落盘给 Mastra |
| [ai-memory.md](ai-memory.md) | 记忆（草案）：短期 thread 落 Redis、长期 `ai_memories` 落 PG、注入与工具写入 |
| [ai-extension-guide.md](ai-extension-guide.md) | 加工具 / 加技能的落地步骤 |
| [ai-usage-stats.md](ai-usage-stats.md) | 用量统计口径：逐轮入库 / 每日 rollup / 多维汇总 |
| [ai-chat-state.md](ai-chat-state.md) | 会话页状态归约：part → 渲染单元 |
| [ai-markdown-fences.md](ai-markdown-fences.md) | AI 消息里的 Markdown 围栏渲染（代码 / JSON / HTML / 图） |

## 后端与数据

| 文档 | 内容 |
| --- | --- |
| [nestjs-migration.md](nestjs-migration.md) | 后端重构：删除 @repo/di、迁移 NestJS 12、kits 全面 Nest 化 |
| [backend-kits-refactor.md](backend-kits-refactor.md) | kits 通用能力封装：一个基础设施一个 module |
| [di-auto-register.md](di-auto-register.md) | 已废弃：`@repo/di` 与 `autoRegister` 随 NestJS 12 重构删除（历史存档） |
| [ported-capabilities.md](ported-capabilities.md) | 从 rihel-base 移植的三项能力：DB 批量 / 时间轮 / Kafka 本地设施 |
| [manual-logger.md](manual-logger.md) | 自建 logger：唯一 pino 实例 / AppLogger / 框架日志接管 |
| [auth-session.md](auth-session.md) | 认证与会话：JWT + Redis 会话 |
| [session-management.md](session-management.md) | 会话管理：登录设备列表 + 单设备下线 |
| [sse.md](sse.md) | 服务端推送：SSE / StreamHub |
| [scheduler.md](scheduler.md) | 定时调度：croner + 时间轮 |

## 监控与通知

| 文档 | 内容 |
| --- | --- |
| [monitor-engine.md](monitor-engine.md) | 监控引擎：指标聚合 / 规则评估 / 告警落库 |
| [monitor-alert.md](monitor-alert.md) | 监控告警：规则 / 触发 / 通道 |
| [notifier.md](notifier.md) | 通知编排：Notifier + file / email / lark 三通道 |

## 前端与设计

| 文档 | 内容 |
| --- | --- |
| [frontend-foundation.md](frontend-foundation.md) | 前端基础建设：质量检查 + SSE 前端链路 + 前台业务闭环 + 实测记录 |
| [design-system.md](design-system.md) | 设计系统：token / 主题 / 字体规范与守卫 |
| [admin-design-language.md](admin-design-language.md) | 后台版面语言与应用层约定 |

## 工程化

| 文档 | 内容 |
| --- | --- |
| [engineering-toolchain.md](engineering-toolchain.md) | 代码检查 / 格式化 / 提交钩子：oxlint + oxfmt + tsgolint + lefthook 的选型与落地（不含 CI） |

## 存储与部署

| 文档 | 内容 |
| --- | --- |
| [storage-access-policy.md](storage-access-policy.md) | 对象存储访问策略：前台可上传 + key 命名空间约束 |
| [file-share.md](file-share.md) | 文件免授权分享：`/s/{token}` 独立分享页 + Next 流转发，OSS 地址不进浏览器 |
