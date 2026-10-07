---
name: notification
description: 在 Billy 工程中发送通知：Notifier 编排统一入口 + FileClient / LarkNotifyClient / EmailClient 三通道、通道配置与未配置降级、发送结果与失败处理、告警通知与新增通道。触发词：通知、发通知、推送通知、告警通知、邮件、SMTP、email、飞书通知、Notifier、NotifyClient、EmailClient、FileClient、LarkNotifyClient、通知通道。
---

# 通知（Notifier / 三通道）

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序——发通知复用
`Notifier` 统一入口与各通道客户端，不自引 nodemailer / 飞书 SDK；飞书协议细节见 `lark` skill）。

## 核心要点

- 编排统一入口 `Notifier`（`kits/src/notification/notifier.ts`）：`send(channel, payload)` 按通道路由，
  自身零发送实现；由 `NotificationModule.forRootAsync`（notify 命名空间）装配。
- **三通道**：`file`（FileClient，零配置默认兜底，追加写 `logs/alerts.log`）、`lark`（LarkNotifyClient，
  基于 LarkClient 发文本）、`email`（EmailClient，nodemailer SMTP）。
- **未配置的通道 `configured=false`，`send` 返回 `{ ok:false, error:'通道未配置' }`**——不抛错。
- 发送失败不抛错：各客户端内部记日志，返回 `SendResult { ok, error? }`；是否落库 / 重试由调用方决定。
- payload 形状：file / lark 只接受 `{ content }`，email 只接受 `{ to, subject, text }`。
- 客户端可绕过 Notifier 直接注入（如只发飞书时 `@Inject(LarkNotifyClient)`）。
- 参考实现：`modules/monitor/alert-trigger.ts`（默认通道判定 + 按通道组装 payload → send → 落 AlertLog）。

## 参考文件（本 skill 的组成部分）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| [references/notification-guide.md](./references/notification-guide.md) | 三通道职责、NotifyConfig 三段配置、send 用法、新增通道步骤、参考实现 | 发通知 / 接通知通道时（必读） |

## 完成检查清单

- [ ] 复用 `Notifier` / 通道客户端（`@Inject`），未散落 import nodemailer / 飞书 SDK
- [ ] 通道配置走 `notify` 命名空间（`LARK_NOTIFY_RECEIVE_ID*` / `ALERT_SMTP_*`），未硬编码
- [ ] 依赖某通道的能力对未配置场景正确处理（`configured` 判定 / 接收 `{ ok:false }` 而非崩溃）
- [ ] 发送失败按调用方诉求落库 / 重试，未让通知异常打断主流程
- [ ] payload 形状与通道匹配（file / lark 用 content，email 用 to / subject / text）
