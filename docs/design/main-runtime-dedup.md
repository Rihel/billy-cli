# main / agent-runtime 去重方案（2026-11-14）

> **状态：已落地**（2026-11-14）。实现与本文的差异：`@repo/monitor` 的动态模块设为
> `global: true`（runtime 的 `AiMonitoringModule` 要注入 `MonitorRegistry`，全局模块避免重复装配
> 出第二个注册表）；main 侧目录客户端叫 `AgentCatalogService`（`apps/main/src/agent/`）。

> 背景：`e5a40af` 拆分分布式架构时，`apps/agent-runtime` 由 `apps/server` 改名而来、
> `apps/main` 由整份复制起步，两边同名文件 117 个 / 7362 行，另有 17 对"同内容不同路径"
> 的提示词与 agent 静态声明。分叉已经在发生（5 个同名文件内容不同，提示词两处各一份）。
>
> 本文是四项去重决定的落地方案：**位置 + 迁移顺序 + 验收**。调研数据见对话中
> 的按模块统计（monitor 57 文件 / ai-model 7 / ai-usage 5 / common 20 / 静态声明 17）。

## 1. 决定（用户已拍板）

| # | 决定 | 落点 | 影响 |
| --- | --- | --- | --- |
| 1 | 静态声明只在 agent-runtime 保留 | runtime `modules/ai/{agents,core/prompts,core/tools,core/skills}`；main 删 `ai-admin/conversation/static/**`，经内部接口取 | main 少 1475 行与本机 `eta` / `@mastra` 依赖 |
| 2 | 监控引擎拆独立包 | 新 `packages/monitor`（`@repo/monitor`）；main 只留 `modules/monitor/api/**` | 两边各少一份 3230 行引擎复制；引擎测试收进包 |
| 3 | common 并入 kits | `packages/kits/src/http/{error,request-context,request-logger,request-metrics,http}` | 两个 app 的 `src/common/**` 删除；`security/` 留在 main（依赖 `resolveServerConfig`） |
| 4 | entities 薄壳直接删 | 模块内直接 `import … from '@repo/db'` | 两个 app 各删 20 个一行 re-export 文件 |

**后续已处理**：`ai-model` 的 runtime 副本已删除（改走 model-gateway）、`ai-usage` 已收进 `@repo/ai-data`；
**仍未纳入**：`app-config.ts` 的整份复制（部署差异，保留）、
`main.ts` / `root.module.ts` / `config.ts`（每个进程各自的组合根，属合理重复）。

## 2. 落点细节

### 2.1 静态声明只留 runtime（控制面只查不算）

runtime 已有 `AgentService.status()/list()/instructions()`（registry 装配产物，提示词只渲染一次，
`/agent/list` 的技能 `*` 现算）。新增三个**内部**端点，main 只做鉴权 + 转发：

| 内部端点 | 入参 | 出参 |
| --- | --- | --- |
| `POST /internal/agent/status` | 无 | `AgentStatusModel` |
| `POST /internal/agent/list` | 无 | `AgentListModel` |
| `POST /internal/agent/instructions` | `AgentInstructionsDto` | `AgentInstructionsModel`（仅 `source='definition'`） |

- 内部端点只校验 `x-internal-token`，不做用户鉴权（main 已完成鉴权）。
- main 新增 `AgentCatalogClient`（`apps/main/src/agent/agent-runtime.client.ts`）：
  走 `@repo/internal-sdk` 的 `requestJson`（解开 runtime 的 `{code,data}` 信封），
  `list()` 结果在进程内缓存 30s（静态声明只在发版时变），供 `create` 校验 agentKey、
  `status` 取 agentCount、`instructions` 快照分支补 name/description。
- `instructions` 的**会话快照分支留在 main**（读 `timelines` 快照 + 归属校验在控制面）；
  只有"无快照 → 渲染静态定义"这一段交给 runtime。
- 前端 `/agent/status|list|instructions` 路径与出入参不变，主连接仍是 main。

### 2.2 `@repo/monitor`

- 搬 `modules/monitor/{definitions,engine,metrics,rules,sources,config.ts}` → `packages/monitor/src/`，
  保持相对导入不变（`./engine/...`）。
- `MonitorModule.forRootAsync({ imports:[ConfigModule], inject:[ConfigService], useFactory: c => c.get('monitor') })`：
  按 kits 基础设施模块模式（`InfraModuleAsyncOptions`），`MonitorConfig` 由模块内 `Schema` 校验 + 补默认值。
- `exports`: `MonitorEngine`、`MonitorRegistry`，以及 main `api/**` 需要的
  `MonitorRuleRepository`、`MetricSampleRepository`、`AlertRepository`、`AlertLogRepository`、
  `SilenceService`、`RuleRegistry`、`MetricRegistry`。
- main 的 `modules/monitor/monitor.module.ts` 改成薄壳：`imports: [MonitorModule.forRootAsync(...), AdminModule]`，
  `controllers` / `providers` 只留 `api/**`；runtime 的 `root.module.ts` 直接 import 包模块。
- 引擎测试 `monitor-lifecycle|registry|window` 迁到 `packages/monitor/test`；main 的
  `monitor-rule-service` 测的是 api 层，留在 main（改从 `@repo/db` / `@repo/monitor` 导入）。

### 2.3 common → kits

- 搬 `apps/main/src/common/{error,http,request-context,request-logger,request-metrics}` →
  `packages/kits/src/http/`，`kits/src/index.ts` 转出；`ERROR_ALERT_HOOK` 一并进 kits
  （monitor 包的告警钩子实现由 app 组合根注入，方向不变）。
- `apps/main/src/common/security/` 留在 main（`rate-limit.guard` 依赖 `apps/main/src/config.ts`
  的 `resolveServerConfig`，属应用配置，不进 kits）；它改为从 `@repo/kits` 取 `BoundaryError` /
  `describeErrorCode`。其余调用方一律 `from '@repo/kits'`。
- 两个 app 的 `src/common/**` 与 `common/index.ts` 删除；`main.ts` / `root.module.ts` 改导入。

### 2.4 entities 薄壳删除

- 57 个文件、99 处导入改为 `@repo/db`（同一文件的多个实体导入合并成一条，纯类型加 `type` 修饰）。
- 删除 `apps/main/src/database/`、`apps/agent-runtime/src/database/`。
- 同步改 `code-conventions.md` 第 6 条（"app 内 shim"的说法作废）。

## 3. 迁移顺序与验收

1. entities 薄壳（最独立）→ `pnpm --filter @app/main typecheck`、`--filter @app/agent-runtime typecheck`。
2. common → kits → 两个 app typecheck + `pnpm --filter @repo/kits test`。
3. monitor 包 → `pnpm build:pkgs` + 两个 app typecheck + `pnpm --filter @repo/monitor test` +
   main `monitor-*` 测试。
4. 静态声明 → runtime 内部端点 + internal-sdk 客户端 + main 代理；
   `pnpm --filter @app/agent-runtime test`（610 项）、`pnpm --filter @app/main test`。
5. `pnpm verify`（lint / 类型感知 / fmt / inject / mastra / redis-raw / ui）。
6. 文档：skill（`billy-dev-foundation` 分层与 common 位置、`develop-ai-agent` 的提示词位置、
   `code-conventions` 第 6 条）、memory（`ai-agent-file-map`、新增去重结论）、
   `docs/dev-logs/2026-11-14.md`、README 架构段落。

## 4. 风险与边界

- **行为变化**：main 的 `/agent/status|list|instructions` 依赖 runtime 可达；runtime 不可用时
  这三个查询返回失败（此前 status 只看库里的模型）。属可接受——对话本身同样依赖 runtime。
- **缓存**：catalog 缓存 30s，发版后最迟 30s 生效；不缓存 instructions（一次性查询，量小）。
- **循环依赖**：`@repo/monitor` 只依赖 kits / shared / db；kits 不反向依赖 monitor。
  `ERROR_ALERT_HOOK` 的 token 在 kits，实现在 app 组合根，方向仍是 app → kits。
- **保留的复制**：`app-config.ts` / `config.ts` / `root.module.ts` 属部署差异；`ai-usage` 的查询/汇总在 `@repo/ai-data`，调度与 AI 用量监控定义只在 main（runtime 不装配）。
