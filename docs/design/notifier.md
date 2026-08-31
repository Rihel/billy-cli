# 通知模块落地方案（notifier）

> 目标：为工程提供**通用通知能力**——飞书（Lark）与邮件（SMTP）。
> **每个第三方服务 = 独立客户端模块**（与 `infrastructure/` 下其它基础设施模块平级），
> **`Notifier` 门面通过 DI 注入各通知客户端**做统一编排与路由，自身不实现任何发送。
>
> 飞书分两层：
> - **`LarkClient`**（`infrastructure/lark/`）：独立 bean，**飞书官方 SDK
>   （@larksuiteoapi/node-sdk）的封装**——创建官方 Client（App 凭证 / 域），暴露 `raw`
>   供业务调用完整飞书 API；
> - **`LarkNotifyClient`**（`infrastructure/lark-notify/`）：**另一个独立 bean**，注入
>   `LarkClient` 实现「通知」语义（发文本消息到配置的接收人 / 群）。
>
> **第一版范围**：`LarkClient` + `LarkNotifyClient` + `EmailClient` + `FileClient` + `Notifier`。
> **FileClient（默认文件输出）**：零配置、始终可用（写 `logs/alerts.log`），未配置 lark / email
> 时作为兜底通道（开发 / 演示开箱即用）。
> 钉钉 / 企业微信为**预留模块**（`infrastructure/dingtalk/`、`infrastructure/wecom/`）：
> 后续按同模式新增目录模块 + Notifier 构造器注入一行即可。

## 1. 背景与选型

- 现状：工程无任何通知能力（无飞书 / 无邮件发送）。
- 诉求（已确认）：
  1. 抽成**独立通用模块**归 kits（`infrastructure/` 下每客户端一个**平级模块**），业务模块共用；
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
    （注入通知客户端），三层各自平级 bean，复用工程 @repo/di 门面。

## 2. 能力归位

| 项 | 决定 |
| --- | --- |
| Notifier 门面 | `packages/kits/src/infrastructure/notifier.ts`（`@Injectable`，构造注入 `LarkNotifyClient` + `EmailClient`，`send(channel, payload)` 路由；`NotifyClient` 接口 + `SendResult`） |
| 飞书官方 SDK 封装 | `packages/kits/src/infrastructure/lark/`（`lark.client.ts` → **`LarkClient`**（独立 bean，暴露 `raw: lark.Client`）+ `index.ts`，平级） |
| 飞书通知客户端 | `packages/kits/src/infrastructure/lark-notify/`（`lark-notify.client.ts` → **`LarkNotifyClient`**（注入 `LarkClient` + `NotifyConfig.lark`，发文本消息）+ `index.ts`，平级） |
| 邮件客户端 | `packages/kits/src/infrastructure/email/`（`email.client.ts` → `EmailClient`，nodemailer + `index.ts`，平级） |
| 钉钉 / 企微（预留） | `infrastructure/dingtalk/`、`infrastructure/wecom/`（后续按同模式新增） |
| 配置分片 | `kits/src/foundation/config/lark-config.ts`（**`LarkConfig`**：appId / appSecret / domain）+ `notify-config.ts`（**`NotifyConfig`**：lark 段（receiveId / receiveIdType）+ email 段；钉钉 / 企微段预留） |
| 依赖 | `@larksuiteoapi/node-sdk` + `nodemailer`（+ `@types/nodemailer` dev）归 `@repo/kits` |

## 3. 接口设计

```ts
// ===== 底层：飞书官方 SDK 封装（独立 bean） =====
// LarkClient（infrastructure/lark/）：@Injectable，注入 LarkConfig
//   readonly raw: lark.Client          // 官方 SDK 客户端（im / contact / drive 完整能力）

// ===== 通知客户端（独立 bean，注入底层客户端） =====
// LarkNotifyClient（infrastructure/lark-notify/）：@Injectable，注入 LarkClient + NotifyConfig.lark
//   发文本消息：raw.im.message.create({ params:{ receive_id_type }, data:{ receive_id, msg_type:'text', content } })
// EmailClient（infrastructure/email/）：nodemailer，to 由调用方决定

interface NotifyClient {
  readonly channel: 'lark' | 'email'
  send(payload: NotifyPayload): Promise<SendResult>   // 失败返回 { ok:false, error }，不抛错
  readonly configured: boolean                         // 未配置的通道不可用
}

type NotifyPayload =
  | { content: string }                                  // lark 文本
  | { to: string; subject: string; text: string }        // email（to 由调用方决定）

interface SendResult { ok: boolean; error?: string }

// ===== Notifier 门面：注入通知客户端，仅编排路由 =====
@Injectable()
class Notifier {
  constructor(
    @Inject(LarkNotifyClient) private readonly lark: LarkNotifyClient,
    @Inject(EmailClient) private readonly email: EmailClient,
    // 预留：钉钉 / 企业微信通知客户端后续在构造器注入
  ) {}
  send(channel: 'lark' | 'email', payload): Promise<SendResult>
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
  lark?: { receiveId: string; receiveIdType?: string }  // 通知目标：open_id（默认）/ chat_id 等
  email?: { host: string; port: number; secure: boolean; user?: string; pass?: string; from: string }
}
```

**目录结构（各 bean 与 kits 其它基础设施模块平级）**：

```
kits/src/infrastructure/           ← 各能力模块平级
├── database/                      （既有）
├── redis-store.ts                 （既有）
├── queue.ts                       （既有）
├── object-storage/                （既有）
├── stream/                        （既有）
├── rate-limit/                    （既有）
├── notifier.ts                    Notifier 门面（@Inject LarkNotifyClient + EmailClient）
├── lark/                          LarkClient（飞书官方 SDK 封装 bean，**第一版**）
│   ├── lark.client.ts             new lark.Client({ appId, appSecret, appType, domain })
│   └── index.ts
├── lark-notify/                   LarkNotifyClient（通知 bean，注入 LarkClient，**第一版**）
│   ├── lark-notify.client.ts      im.message.create 发文本消息
│   └── index.ts
└── email/                         EmailClient（nodemailer，**第一版**）
    ├── email.client.ts
    └── index.ts
<!-- 预留：dingtalk/、wecom/ 后续按同模式新增平级目录模块 -->
```

## 4. 关键设计

- **三层解耦（飞书）**：`LarkClient`（官方 SDK 封装，协议 / 凭证）→ `LarkNotifyClient`
  （通知语义：目标 + 消息形状）→ `Notifier`（编排路由）；各层独立 bean、可独立测试与替换；
- **Notifier = 注入通知客户端编排**：`send(channel, payload)` 按 channel 路由；自身零发送
  实现；新增通知通道 = 新增一个通知客户端目录模块 + 构造器注入一行；
- **装配**：`service-context.ts`——`lark` 分片存在 → 注册 `LarkClient`；`notify` 分片存在 →
  注册 `Notifier` + `EmailClient`；`lark` 与 `notify.lark` 都存在 → 注册 `LarkNotifyClient`
  （依赖齐全才装配，缺失即 DI 报错）；
- **失败降级**：各客户端捕获所有异常返回 `{ ok:false, error }`（内部记日志），不向调用方
  抛错；调用方（如 monitor）自行决定落库 / 重试；
- **职责边界**：客户端与 Notifier 只做「通道发送 + 协议适配」，不做限频 / 重试 / 落库
  （由业务方负责）。

## 5. 使用示例

```ts
const notifier = runtime.get(Notifier)
await notifier.send('lark', { content: '订单支付失败：xxx' })
await notifier.send('email', { to: 'ops@corp.com', subject: '告警', text: '...' })

// 也可绕过 Notifier 直接注入客户端：
const larkNotify = runtime.get(LarkNotifyClient)
await larkNotify.send({ content: '直接发飞书通知' })
// 底层协议能力（如查用户、上传）直接用 LarkClient：
const lark = runtime.get(LarkClient)
await lark.raw.im.message.create({ ... })
```

## 6. 测试（kits vitest）

- `test/lark.test.ts`——`LarkClient`：按配置创建官方 Client（`raw.im.message.create` 可用）；
- `test/lark-notify.test.ts`——`LarkNotifyClient`：mock `LarkClient.raw.im.message.create`，
  断言 payload（`msg_type:'text'` / `receive_id_type` / receive_id）、未配置 → `{ ok:false }`、
  API 异常降级、chat_id 群通知；
- `test/email.test.ts`——nodemailer mock（transport 创建 + sendMail 参数、SMTP 失败降级）；
- `test/notifier.test.ts`——注入 mock 客户端，`send` 按 channel 路由、失败结果透传。

## 7. 边界 / 注意

- 发送失败不抛错（记日志），调用方负责重试 / 落库；
- `email.to` 由调用方传入（业务按场景决定接收人），`from` 在配置；
- `LarkNotifyClient` 的 `receiveId`（通知目标）在 `NotifyConfig.lark` 配置；
  需要按用户维度通知时，业务可绕过它直接用 `LarkClient.raw.im.message` 按业务场景发；
- 未配置的通道客户端 `configured=false`，`send` 返回 `{ ok:false, error: '通道未配置' }`；
- 配置均为可选分片：`createServiceContext({ lark, notify })` 传入才装配。

## 8. 评审确认点

1. **第一版范围**：LarkClient + LarkNotifyClient + EmailClient + FileClient（默认文件输出）+ Notifier——确认？
2. **LarkClient**（官方 SDK 封装 bean，暴露 raw 完整能力）与 **LarkNotifyClient**（通知 bean，
   注入 LarkClient）两层分离——确认？
3. 每第三方服务一个**独立客户端模块**（与基础设施平级、独立可用）——确认？
4. **Notifier 通过 DI 注入通知客户端**做编排路由（自身零发送实现）——确认？
5. `email.to` 由调用方传入（配置只含 SMTP + from）——确认？
6. 发送失败不抛错（`{ ok:false }`），重试 / 落库归调用方——确认？
7. 依赖 @larksuiteoapi/node-sdk + nodemailer 归 kits——确认？
