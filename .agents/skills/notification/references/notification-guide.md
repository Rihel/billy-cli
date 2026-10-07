# 通知详解（notification 引用文件）

> 本文件是 `notification` skill 的组成部分，由主 SKILL.md 引用。
> 发通知 / 接通知通道时必读。

## 1. 统一入口与装配

`Notifier`（`kits/src/notification/notifier.ts`）是编排统一入口：`send(channel, payload)` 按通道路由，
自身零发送实现。`NotificationModule.forRootAsync`（notify 命名空间）装配 Notifier + 三个客户端；
未导入 `LarkModule` 时 `LarkClient` 缺失，`LarkNotifyClient` 以 `@Optional()` 降级。

## 2. 三个通道

| 通道 | 客户端 | 依赖 | 用途 |
| --- | --- | --- | --- |
| `file` | `FileClient` | 无（零配置兜底） | 追加写文件（默认 `logs/alerts.log`） |
| `lark` | `LarkNotifyClient` | `LarkClient`（LarkModule） | 飞书文本消息 |
| `email` | `EmailClient` | nodemailer SMTP | 邮件（to 由调用方传，from 在配置） |

## 3. 配置（NotifyConfig）

`NotifyConfigSchema`（`kits/src/notification/notify.config.ts`）三段独立：
`file`（`path`，默认 `logs/alerts.log`）、`lark`（`receiveId` + `receiveIdType`，默认 `open_id`）、
`email`（`host` / `port` / `secure` / `user` / `pass` / `from`）。

**未配置的段 → 对应客户端 `configured=false`，`send` 返回 `{ ok:false, error:'通道未配置' }`**。
环境变量映射见 `apps/server/src/app-config.ts` 的 `notify` 段（`LARK_NOTIFY_RECEIVE_ID` /
`LARK_NOTIFY_RECEIVE_ID_TYPE` / `ALERT_SMTP_*`）。

## 4. 发送

```ts
await notifier.send('lark', { content: '文本' })   // file / lark 用 content
await notifier.send('email', { to, subject, text }) // email 用 to / subject / text
```

- 失败不抛错：各客户端内部 `AppLogger.error` 记日志，返回 `SendResult { ok, error? }`。
- 客户端可绕过 Notifier 直接注入（如只发飞书时 `@Inject(LarkNotifyClient)`）。

## 5. 新增通道（钉钉 / 企业微信预留）

按 `NotifyClient` 接口新增平级目录模块（`kits/src/notification/<channel>/<channel>.client.ts`），
在 `Notifier` 构造器注入 + 加一个路由分支，`NotifyChannel` / `NotifyPayload` 同步扩展；调用方接口不变。

## 6. 参考实现

`apps/server/src/modules/monitor/alert-trigger.ts`：
- `defaultChannels()` 用各客户端 `configured` 判定默认技术规则通道；
- `deliver()` 按通道组装 payload → `notifier.send` → 逐通道落 `AlertLog`（发送 / 落库失败均不抛错）。
