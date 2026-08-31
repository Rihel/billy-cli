# 监控告警模块落地方案（monitor-alert）

> 目标：为工程提供**可管理的告警能力**——独立业务模块，告警规则在 admin 后台配置
> （业务告警 + 技术告警）。**发送能力不在此文档范围**：走通用通知模块
> `kits/infrastructure/`（见 [notifier.md](./notifier.md)——`LarkClient`（官方 SDK 封装）+
> `LarkNotifyClient`（通知 bean，注入 LarkClient）+ `EmailClient` 各为平级模块，
> `Notifier` 通过 DI 注入通知客户端编排）。
> monitor 只做规则 / 匹配 / 触发 / 记录，发送归通知模块。
> 配套轻量健康检查端点。

## 1. 背景与选型

- 现状：工程只有请求日志（`lib/request-logger.ts`）与错误映射（`lib/http.ts` 的
  `errorHandler` 仅 `console.error`），**无告警能力、无健康检查**。
- 诉求（已确认）：
  1. 做成**独立业务模块**（`apps/server/src/modules/monitor/`），规则在 admin 后台管理；
  2. **告警规则可配置**：技术告警（ERROR 级错误 / 未捕获异常）+ 业务告警（错误码 / 关键字匹配）；
  3. 发送走**通用通知模块**（`@repo/kits` 的 `Notifier`，见 notifier.md），monitor 不实现发送；
  4. 配套：轻量健康检查 `GET /monitor/health`（DB / Redis 探活，供 Docker / k8s / 云平台探针）。
  - ~~请求指标（Prometheus）~~：评审后**砍掉**——指标需配套 Prometheus / Grafana 才有实际
    价值，属过度设计，且与「admin 管理」诉求无关。
- 选型结论：
  - **规则存储**：数据库表（TypeORM 实体），admin 可 CRUD（可配置的落点）；
  - **限频防风暴**：进程内 Map（同一规则 + 相同内容在窗口内只发一次），第一版单实例；
    多实例部署后续接 Redis 共享限频（与 `RateLimiter` 同思路）。

## 2. 能力归位

| 项 | 决定 |
| --- | --- |
| 通知能力（通用） | `packages/kits/src/infrastructure/`（**独立文档** [notifier.md](./notifier.md)：`notifier.ts` 门面（DI 注入通知客户端）+ `lark/`（LarkClient 官方 SDK 封装）+ `lark-notify/`（LarkNotifyClient）+ `email/`（EmailClient）**各为平级模块** + LarkConfig / NotifyConfig 分片） |
| 契约（schema） | `packages/shared/src/schema/monitor.schema.ts`（AlertRule / AlertLog / 请求 DTO），`schema/index.ts` 导出 |
| 实体 | `apps/server/src/database/entities/{alert-rule,alert-log}-entity.ts`，`main.ts` 注入 `entities` + `db:gen` 生成迁移 |
| 业务 | `apps/server/src/modules/monitor/{errors,repository,service,config,index}.ts`（`AlertRuleService` 规则 CRUD + `MonitorService` 告警核心：匹配 / 限频 / 调 `Notifier` 发送 / 落日志） |
| 告警配置 | `modules/monitor/config.ts` 的 `MonitorConfig`（env：`ALERT_ENABLED` / `ALERT_EMAIL_TO` 告警默认接收人；通道接入点本身在 `NotifyConfig`） |
| Hono 路由 | `apps/server/src/features/monitor.ts`：`/monitor/rule/*`、`/monitor/log/*`、`/monitor/test`、`/monitor/health`（admin 鉴权） |
| 告警接入 | `main.ts` 的 `app.onError` 闭包（技术错误 → `MonitorService.notifyError`，异步 fire-and-forget）+ `process` 的 `uncaughtException` / `unhandledRejection` |
| SDK | `packages/sdk/src/server.client.ts` 的 `monitor` 段 |
| admin 页面 | `apps/admin/src/app/main/monitor/{rules,logs}/page.tsx` + `AppMenu.tsx` 菜单（系统设置组下） |
| 依赖 | monitor 模块**零新增依赖**（发送由 kits Notifier 承担，其依赖 nodemailer 归 kits） |

## 3. 数据结构

### 3.1 AlertRuleEntity（表 `alert_rules`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | varchar(50) **unique** | 规则名称（语义化，如「登录失败告警」） |
| `type` | varchar | `tech` 技术告警 / `business` 业务告警 |
| `matchCodes` | jsonb（number[]） | 匹配错误码（AppErrorCodes 数字码）；空数组 = 匹配该类型全部错误 |
| `keywords` | text[]（simple-array） | 匹配消息关键字（任一命中即匹配）；空数组 = 不限制 |
| `level` | varchar | `warn` / `error`（error 级规则同时捕获 warn） |
| `channels` | text[]（simple-array） | 发送通道 `lark` / `email`（至少一个，schema 校验） |
| `throttleSeconds` | int | 限频窗口秒（默认 60，防告警风暴） |
| `enabled` | bool | 是否启用（默认 true） |

+ `BaseEntity`（id nanoid / createdAt / updatedAt / 软删除 deletedAt）

### 3.2 AlertLogEntity（表 `alert_logs`，发送记录 / 审计）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ruleId` | varchar nullable | 命中的规则 id（默认规则为空） |
| `ruleName` | varchar | 规则名 |
| `title` / `message` | text | 告警标题与正文 |
| `channel` | varchar | `lark` / `email` |
| `status` | varchar | `success` / `failed` |
| `error` | text nullable | 发送失败原因 |
| `sentAt` | timestamptz | 发送时间 |

+ 索引：`sentAt`、`ruleId`；`BaseEntity`

### 3.3 契约（monitor.schema.ts）

- `AlertRuleSchema` / `CreateAlertRuleSchema` / `UpdateAlertRuleSchema`（partial）/
  `PageQueryAlertRuleSchema`（keyword / type / enabled）
- `AlertLogSchema` / `PageQueryAlertLogSchema`（ruleId / channel / status）
- `TestAlertSchema`（title / message / channels，手动验证通道）

## 4. 关键设计

### 4.1 规则匹配（MonitorService）

`notifyError(error, context?)`：

1. 取 `error.code`（AppError 子类自带数字码）与 `message`；
2. 候选规则 = `enabled` 且 type 匹配（技术错误匹配 `tech` 规则；业务错误按 `matchCodes`
   含 code 或 `keywords` 任一命中 message 匹配 `business` 规则）且 level 覆盖（error 级错误
   匹配 `warn` + `error` 规则）；
3. 无候选 `tech` 规则且 `MonitorConfig.enabled` → 使用**内置默认规则**（channels =
   配置启用的通道），保证规则表为空时技术告警开箱即用；
4. 命中 → 限频检查 → 按 channels 逐通道调 `Notifier.send(channel, ...)` → 写 `AlertLog`
   （每通道一条记录，记录 `SendResult` 成败与错误）。

### 4.2 发送能力（引用 notifier.md）

monitor **不实现发送**：规则 channels 中的 `lark` 对应通知模块的 `LarkNotifyClient`
（注入 `LarkClient` 官方 SDK），`email` 对应邮件客户端
（`to` 取 `MonitorConfig.emailTo`）。通道细节见 [notifier.md](./notifier.md)。

### 4.3 限频防风暴

进程内 `Map<`${ruleId}:${contentHash}`, lastSentAt>`；`throttleSeconds` 窗口内相同内容
不再发送；惰性清理过期条目。多实例部署后续接 Redis 共享限频（评审点）。

### 4.4 健康检查

`GET /monitor/health`：`{ status: 'ok' | 'degraded', uptimeSeconds, checks: { db, redis } }`，
探活 `SELECT 1`（Db.dataSource）与 `PING`（RedisStore.raw），任一失败 status=degraded。
供 Docker / k8s / 云平台探针使用；无第三方依赖。

### 4.5 告警接入（不改变既有错误映射）

- `app.onError`：在既有 `errorHandler` 同时调用 `MonitorService.notifyError(error, { path, requestId })`
  （异步 fire-and-forget，不阻塞响应、失败不影响返回）；
- `process.on('uncaughtException' | 'unhandledRejection')`：notifyError + 记日志
  （uncaughtException 记录后按 Node 默认行为退出，避免进程悬挂）。

## 5. 使用示例

```ts
// admin 后台建规则：type=business、matchCodes=[3101]、channels=[lark,email]
// 业务方抛 AlertRuleNotFoundError → MonitorService 匹配 → 调 Notifier 推送 + 落 AlertLog
// curl -H 'Authorization: Bearer <admin-token>' /monitor/health
```

## 6. 测试

- **apps/server 引入 vitest**（devDep + `test` script，补 server 测试基建）：
  - `AlertRuleService`：CRUD、name 唯一冲突（3102）、查无（3101）；
  - `MonitorService`：规则匹配（codes / keywords / level）、默认规则兜底、限频去重、
    调 Notifier 与 AlertLog 落库（mock Notifier / repository）。
- **kits**：通知模块测试见 [notifier.md](./notifier.md)（各适配器独立测）。
- 端到端：`/monitor/health`、规则 CRUD + 测试告警触发。

## 7. 边界 / 注意

- 限频第一版**进程内**（单实例）；多实例部署后续接 Redis 共享限频。
- Notifier 发送失败返回 `{ ok:false }`（记日志），AlertLog 写库失败也不影响业务响应。
- `/monitor/*` 全部 admin 鉴权（`AUTH_ENABLED=false` 时守卫放行，与既有语义一致）。
- 规则表为空时技术告警走配置通道兜底（开箱即用）；有规则后按规则执行。
- `matchCodes` 用 jsonb（number[] 原生存取，避免 simple-array 的字符串转换）。
- `MonitorConfig.emailTo`（env `ALERT_EMAIL_TO`）为告警默认邮件接收人（email 的 `to` 由调用方传入）。

## 8. 评审确认点

1. 端点路径挂 `/monitor/health`（不占顶级 `/health`）——确认？
2. 发送能力走通用通知模块（notifier.md，kits），monitor 零发送实现——确认？
3. 规则表为空时技术告警用配置通道**兜底**（开箱即用）——确认？
4. **apps/server 引入 vitest** 补测试基建并写 monitor 单测——确认？
5. 限频第一版进程内（多实例后续接 Redis）——确认？
6. 规则「至少一个通道」由 schema 强制（channels min 1）——确认？
