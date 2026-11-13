# 通知模块落地方案（notifier）

> 目标：为工程提供**通用通知能力**——飞书（Lark）与邮件（SMTP）。
> **每个第三方服务 = 独立客户端模块**（与 `kits/src/` 下其它基础设施目录平级），
> **`Notifier` 统一入口通过 DI 注入各通知客户端**做统一编排与路由，自身不实现任何发送。
>
> 飞书分两层：
> - **`LarkClient`**（`kits/src/lark/`）：独立 bean，**飞书官方 SDK
>   （@larksuiteoapi/node-sdk）的封装**——创建官方 Client（App 凭证 / 域），暴露 `raw`
>   供业务调用完整飞书 API；
> - **`LarkNotifyClient`**（`kits/src/notification/lark-notify/`）：**另一个独立 bean**，注入
>   `LarkClient` 实现「通知」语义（发文本消息到配置的接收人 / 群）。
>
> **第一版范围**：`LarkClient` + `LarkNotifyClient` + `EmailClient` + `FileClient` + `Notifier`。
> **FileClient（默认文件输出）**：零配置、始终可用（写 `logs/alerts.log`），未配置 lark / email
> 时作为兜底通道（开发 / 演示开箱即用）。
> 钉钉 / 企业微信为**预留能力**（尚未建目录）：后续按同模式新增
> `notification/dingtalk/`、`notification/wecom/` 目录模块 + Notifier 构造器注入一行即可。
>
> 2026-11-13 核对（现状口径）：
> - 通道共三个：`file` / `lark` / `email`（`NotifyChannel`），`Notifier.send(channel, payload)` 路由；
> - `Notifier` 构造器注入的是 **`FileClient` + `LarkNotifyClient` + `EmailClient` 三个客户端**
>   （均为 `@Optional()`，未装配的通道返回 `{ ok:false, error: '通道未配置：<channel>' }`），
>   源码里没有 dingtalk / wecom 目录；
> - 配置来源是应用配置的 `notify` 命名空间（`apps/server/src/app-config.ts` 的 `mapServerEnv`），
>   `NotificationModule.forRootAsync` 注入；环境变量对照见 §9。

## 1. 背景与选型

- 现状：工程无任何通知能力（无飞书 / 无邮件发送）。
- 诉求（已确认）：
  1. 抽成**独立通用模块**归 kits（`kits/src/<name>/` 下每客户端一个**平级目录**），业务模块共用；
  2. **每个第三方服务 = 独立客户端**：`LarkClient`（官方 SDK 封装）/ `EmailClient` 等
     各自独立目录与类，内部自包含，**可独立使用**（业务可直接注入客户端）；
  3. **通知客户端基于底层客户端实现**：`LarkNotifyClient` 注入 `LarkClient`（官方 SDK），
     只关心「通知目标与消息形状」，协议细节归 `LarkClient`；
  4. **Notifier 基于注入各通知客户端实现**：构造器 `@Inject`，`send(channel, payload)` 路由，
     仅做统一入口与编排；
  5. 发送失败**不抛错**（返回 `{ ok:false, error }` 并记日志），由调用方决定落库 / 重试；
  6. 通道配置独立（`NotifyConfig` 各通道独立配置段；未配置的通道客户端不可用）。
- 选型结论（按「不重复造轮子」实现查找顺序评估）：
  - **飞书**：官方 SDK **`@larksuiteoapi/node-sdk`**（自研 webhook fetch 被否——用官方客户端）；
  - **邮件**：`nodemailer`（标准 SMTP 客户端）作为 EmailClient 底层；
  - **组织方式**：底层客户端（官方 SDK 封装）+ 通知客户端（注入底层客户端）+ Notifier
    （注入通知客户端），三层各自平级 bean，复用 `@nestjs/common` 的 DI 机制（`@Injectable` + 构造器 `@Inject`）。

## 2. 能力放在哪

| 项 | 决定 |
| --- | --- |
| Notifier 统一入口 | `packages/kits/src/notification/notifier.ts`（`@Injectable`，构造注入 `FileClient` + `LarkNotifyClient` + `EmailClient`，`send(channel, payload)` 路由；`NotifyChannel` / `NotifyClient` 接口 + `SendResult`） |
| 飞书官方 SDK 封装 | `packages/kits/src/lark/`（`lark.client.ts` → **`LarkClient`**（独立 bean，暴露 `raw: lark.Client`）+ `lark.module.ts` + `index.ts`） |
| 飞书通知客户端 | `packages/kits/src/notification/lark-notify/`（`lark-notify.client.ts` → **`LarkNotifyClient`**（`@Optional()` 注入 `LarkClient` + `NotifyConfig.lark`，发文本消息）+ `index.ts`） |
| 邮件客户端 | `packages/kits/src/notification/email/`（`email.client.ts` → `EmailClient`，nodemailer + `index.ts`） |
| 文件输出客户端 | `packages/kits/src/notification/file/`（`file.client.ts` → `FileClient`，node fs 追加写，`configured` 恒 true） |
| 钉钉 / 企微（预留） | **尚未建目录**；后续按同模式在 `packages/kits/src/notification/` 下新增 `dingtalk/`、`wecom/` |
| 配置 bean | `kits/src/lark/lark.config.ts`（**`LarkConfig`**：appId / appSecret / domain）+ `kits/src/notification/notify.config.ts`（**`NotifyConfig`**：`file`（path，默认 `logs/alerts.log`）+ `lark` 段（receiveId / receiveIdType）+ `email` 段；钉钉 / 企微段未定义） |
| 依赖 | `@larksuiteoapi/node-sdk` + `nodemailer`（+ `@types/nodemailer` dev）归 `@repo/kits` |

## 3. 接口设计

```ts
// ===== 底层：飞书官方 SDK 封装（独立 bean） =====
// LarkClient（kits/src/lark/）：@Injectable，注入 LarkConfig
//   readonly raw: lark.Client          // 官方 SDK 客户端（im / contact / drive 完整能力）

// ===== 通知客户端（独立 bean，注入底层客户端） =====
// LarkNotifyClient（kits/src/notification/lark-notify/）：@Injectable，@Optional 注入 LarkClient + NotifyConfig.lark
//   发文本消息：raw.im.message.create({ params:{ receive_id_type }, data:{ receive_id, msg_type:'text', content } })
// FileClient（kits/src/notification/file/）：node fs 追加写，零配置、configured 恒 true

interface NotifyClient {
  readonly channel: 'file' | 'lark' | 'email'
  send(payload: NotifyPayload): Promise<SendResult>   // 失败返回 { ok:false, error }，不抛错
  readonly configured: boolean                         // 未配置的通道不可用
}

type NotifyPayload =
  | { content: string }                                  // file / lark 文本
  | { to: string; subject: string; text: string }        // email（to 由调用方决定）

interface SendResult { ok: boolean; error?: string }

// ===== Notifier 统一入口：注入通知客户端，仅编排路由 =====
@Injectable()
class Notifier {
  constructor(
    @Inject(FileClient) @Optional() private readonly file?: FileClient,
    @Inject(LarkNotifyClient) @Optional() private readonly lark?: LarkNotifyClient,
    @Inject(EmailClient) @Optional() private readonly email?: EmailClient,
    // 预留：钉钉 / 企业微信通知客户端后续在构造器注入
  ) {}
  send(channel: 'file' | 'lark' | 'email', payload): Promise<SendResult>
}
```

**配置（LarkConfig / NotifyConfig，各通道独立配置段）**：

```ts
interface LarkConfig {
  appId: string
  appSecret: string
  domain?: 'feishu' | 'lark'          // 默认 feishu
}

interface NotifyConfig {
  file?: { path?: string }                              // 默认 logs/alerts.log
  lark?: { receiveId: string; receiveIdType?: string }  // 通知目标：open_id（默认）/ chat_id 等
  email?: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }
}
```

**目录结构**（kits 现在是「一个基础设施一个目录」，通知相关 bean 分属两个目录）：

```
packages/kits/src/
├── notification/                  ← 通知能力目录（NotificationModule）
│   ├── notifier.ts                Notifier 统一入口（@Inject FileClient + LarkNotifyClient + EmailClient，均 @Optional）
│   ├── notify.config.ts           NotifyConfig（file / lark / email 段）
│   ├── notification.module.ts     @Global + forRoot / forRootAsync：NotifyConfig + Notifier + 三个客户端
│   ├── lark-notify/               LarkNotifyClient（@Optional 注入 LarkClient，**第一版**）
│   │   ├── lark-notify.client.ts  im.message.create 发文本消息
│   │   └── index.ts
│   ├── email/                     EmailClient（nodemailer，**第一版**）
│   │   ├── email.client.ts
│   │   └── index.ts
│   ├── file/                      FileClient（node fs 追加写，零配置、始终可用）
│   │   ├── file.client.ts
│   │   └── index.ts
│   └── index.ts
└── lark/                          ← 飞书协议能力目录（LarkModule）
    ├── lark.client.ts             LarkClient（飞书官方 SDK 封装 bean，**第一版**）
    │                              new lark.Client({ appId, appSecret, appType, domain })
    ├── lark.config.ts             LarkConfig
    ├── lark.module.ts             @Global + forRoot：LarkConfig + LarkClient
    └── index.ts
<!-- 预留：dingtalk/、wecom/ 尚未建目录，后续按同模式在 notification/ 下新增平级目录 -->
```

## 4. 关键设计

- **三层解耦（飞书）**：`LarkClient`（官方 SDK 封装，协议 / 凭证）→ `LarkNotifyClient`
  （通知语义：目标 + 消息形状）→ `Notifier`（编排路由）；各层独立 bean、可独立测试与替换；
- **Notifier = 注入通知客户端编排**：`send(channel, payload)` 按 channel 路由；自身零发送
  实现；新增通知通道 = 新增一个通知客户端目录模块 + 构造器注入一行；
- **装配**：`NotificationModule.forRoot(options)` / `forRootAsync(...)` 恒定装配 `Notifier` +
  `FileClient` + `EmailClient` + `LarkNotifyClient`（应用侧走 `forRootAsync`，配置来自 `notify`
  命名空间）；飞书协议能力在 `LarkModule.forRoot(...)`，未 import `LarkModule`
  时 `LarkNotifyClient` 的 `LarkClient` 以 `@Optional()` 注入为 undefined，该通道自动降级为「未配置」；
- **失败降级**：各客户端捕获所有异常返回 `{ ok:false, error }`（内部记日志），不向调用方
  抛错；调用方（如 monitor）自行决定落库 / 重试；
- **职责边界**：客户端与 Notifier 只做「通道发送 + 协议适配」，不做限频 / 重试 / 落库
  （由业务方负责）。

## 5. 使用示例

```ts
// 构造器注入（controller / service 一律显式 @Inject）
// notifier 由构造器注入：@Inject(Notifier) private readonly notifier: Notifier
await notifier.send('lark', { content: '订单支付失败：xxx' })
await notifier.send('email', { to: 'ops@corp.com', subject: '告警', text: '...' })

// 也可绕过 Notifier 直接注入客户端：
// larkNotify 由构造器注入：@Inject(LarkNotifyClient)
await larkNotify.send({ content: '直接发飞书通知' })
// 底层协议能力（如查用户、上传）直接用 LarkClient：
// lark 由构造器注入：@Inject(LarkClient)
await lark.raw.im.message.create({ ... })
```

## 6. 测试（kits vitest）

- `test/lark.test.ts`——`LarkClient`：按配置创建官方 Client（`raw.im.message.create` 可用）；
- `test/lark-notify.test.ts`——`LarkNotifyClient`：mock `LarkClient.raw.im.message.create`，
  断言 payload（`msg_type:'text'` / `receive_id_type` / receive_id）、未配置 → `{ ok:false }`、
  API 异常降级、chat_id 群通知；
- `test/email.test.ts`——nodemailer mock（transport 创建 + sendMail 参数、SMTP 失败降级）；
- `test/file-client.test.ts`——`FileClient`：追加写、目录自动创建、路径来自 `NotifyConfig.file.path`；
- `test/notifier.test.ts`——注入 mock 客户端，`send` 按 channel 路由、失败结果透传。

## 7. 边界 / 注意

- 发送失败不抛错（记日志），调用方负责重试 / 落库；
- `email.to` 由调用方传入（业务按场景决定接收人），`from` 在配置；
- `LarkNotifyClient` 的 `receiveId`（通知目标）在 `NotifyConfig.lark` 配置；
  需要按用户维度通知时，业务可绕过它直接用 `LarkClient.raw.im.message` 按业务场景发；
- 未配置的通道客户端 `configured=false`，`send` 返回 `{ ok:false, error: '通道未配置：<channel>' }`；
- 通道配置均为可选：`NotificationModule.forRoot / forRootAsync` 不传即该通道未配置；
  `LarkModule.forRoot(...)` 未 import 时飞书通道自动降级（`LarkClient` 以 `@Optional()` 注入为 undefined）。

## 8. 评审确认点

1. **第一版范围**：LarkClient + LarkNotifyClient + EmailClient + FileClient（默认文件输出）+ Notifier——确认？
2. **LarkClient**（官方 SDK 封装 bean，暴露 raw 完整能力）与 **LarkNotifyClient**（通知 bean，
   注入 LarkClient）两层分离——确认？
3. 每第三方服务一个**独立客户端模块**（与基础设施平级、独立可用）——确认？
4. **Notifier 通过 DI 注入通知客户端**做编排路由（自身零发送实现）——确认？
5. `email.to` 由调用方传入（配置只含 SMTP + from）——确认？
6. 发送失败不抛错（`{ ok:false }`），重试 / 落库归调用方——确认？
7. 依赖 @larksuiteoapi/node-sdk + nodemailer 归 kits——确认？

## 9. 环境变量与现状对照（2026-11-13）

| 环境变量 | 映射到 | 说明 |
| --- | --- | --- |
| `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` | `LarkConfig`（`app-config.ts`） | 两者都在才装配 `LarkModule`；否则飞书通道降级 |
| `LARK_NOTIFY_RECEIVE_ID` / `LARK_NOTIFY_RECEIVE_ID_TYPE` | `NotifyConfig.lark` | 收件人 id 与类型（`open_id` 默认，支持 `chat_id` / `union_id` / `user_id` / `email`） |
| `ALERT_SMTP_HOST` / `_PORT` / `_SECURE` / `_USER` / `_PASS` / `_FROM` | `NotifyConfig.email` | `ALERT_SMTP_HOST` 存在才启用邮件通道 |
| `ALERT_ENABLED` / `ALERT_EMAIL_TO` / `MONITOR_INSTANCE_ID` / `MONITOR_SAMPLE_RETENTION_DAYS` | `MonitorConfig`（`monitor` 命名空间） | 告警总开关与邮件默认收件人；**不属于** NotifyConfig |
| （无环境变量） | `NotifyConfig.file` | 文件通道路径固定默认 `logs/alerts.log`，未暴露 env |

- 说明：`NotifyConfig` 由 `apps/server/src/app-config.ts` 的 `notify` 命名空间组装
  （只映射 lark / email 两段），`root.module.ts` 用 `NotificationModule.forRootAsync` 注入；
- 发送结果的落库（`alert_logs`）与静默 / 重试**不在 Notifier**：由监控模块的
  `AlertDeliveryService` 负责，见 `monitor-engine.md` §7.5 / §9.4。
