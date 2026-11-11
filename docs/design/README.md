# 设计文档

> 每篇回答「这个能力为什么长这样、当时取舍了什么」。使用与操作见 [../guide/](../guide/)；
> 哪天改的见 [../dev-logs/](../dev-logs/)。

## AI

| 文档 | 内容 |
| --- | --- |
| [ai-agent.md](ai-agent.md) | AI 运行时：会话 / 运行 / 流式 / 上下文 / 恢复 |
| [ai-file-manager.md](ai-file-manager.md) | AI 文件管理：会话级文件树 / 对象存储 / 提交与回读 / 前端预览下载 |
| [ai-agent-tool-engine.md](ai-agent-tool-engine.md) | 工具引擎：工具组 / 注册机 / 网关插件 / 配置入库 |
| [ai-skill-library.md](ai-skill-library.md) | 技能库：在线编辑 / 链接导入（skills.sh、GitHub）/ 启停，DB 是事实源、落盘给 Mastra |
| [ai-connector.md](ai-connector.md) | **已归档（2026-11-10）**：连接器四层模型与各驱动的历史论证；方向见 skill `develop-ai-agent/references/connector.md` |
| [ai-extension-guide.md](ai-extension-guide.md) | 加工具 / 加技能 / 加连接器的落地步骤 |
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

## 存储与部署

| 文档 | 内容 |
| --- | --- |
| [storage-access-policy.md](storage-access-policy.md) | 对象存储访问策略：前台可上传 + key 命名空间约束 |
