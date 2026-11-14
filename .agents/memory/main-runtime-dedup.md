# main / agent-runtime 的共享边界（去重后）

> **查证优先级：抽核** —— 记的是「谁有、谁没有」，2026-11-14 去重后成立；
> 再拆分 / 抽包时先看这张卡再动。

## 结论

| 能力 | 归属 | 理由 |
| --- | --- | --- |
| 横切 HTTP（错误 / 请求上下文 / 日志 / 指标 / Zod 校验 / 信封 / 探针路径） | `@repo/kits` 的 `src/http/` | 每个进程都要装配，语义与业务无关 |
| main 专属访问控制（`extractToken` / `RateLimit` / `anyOfGuards`） | `apps/main/src/common/security/` | 依赖应用级 `ServerConfig`（后端地址 / 白名单 / 开关），kits 不能依赖 app 配置 |
| 监控引擎（指标 / 规则 / 告警 / 通知） | `@repo/monitor`（`MonitorModule.forRootAsync`，`global: true`） | 两个进程各自监控自己，引擎必须共用一份；HTTP API 只在 main |
| 数据库实体 | `@repo/db` | app 内**没有** `src/database/entities` 薄壳，直接 import |
| agent 静态声明（规格 / 提示词 / 工具选择器 / 技能类型） | 只在 `apps/agent-runtime/src/modules/ai/` | 渲染结果就是模型实际收到的指令，不能第二份 |
| main 的 agent 查询 | `AgentCatalogService` → runtime 内部接口（缓存 30s） | 控制面只查不算；`status/list/instructions` 三个端点由 main 代理 |
| `app-config.ts` / `config.ts` / `root.module.ts` | 两个 app 各一份 | 组合根与配置 shape 属部署差异，共用反而耦合 |
| `ai-model` 数据访问 | **只剩 main 一份**；runtime 走 `model-gateway` 目录，不读配置表 | 2026-11-15 删除 runtime `modules/ai-model/**` |
| `ai-usage` 数据访问 | 仍各一份（**未去重**） | 下一步候选；改动时两边都要同步 |

**反向约束**：`@repo/monitor` / `@repo/kits` 不得 import `apps/*`；main 不再依赖 `@mastra/*` / `eta`。

## 依据

- `packages/kits/src/http/`、`packages/monitor/src/`、`apps/main/src/agent/agent-catalog.service.ts`
- 设计：`docs/design/main-runtime-dedup.md`

## 失效信号

再有文件被两个 app 同时需要时，先判断它是「进程横切」还是「部署差异」：
前者抽到 kits / 独立包，后者才各留一份。`git diff --no-index apps/main/src apps/agent-runtime/src`
同名文件数上升即说明又有人复制了。
