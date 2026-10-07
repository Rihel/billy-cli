---
name: lark
description: 在 Billy 工程中使用飞书（Lark / Feishu）开放平台：LarkClient 统一入口（官方 SDK 封装）、应用配置（appId / appSecret / domain）、可选装配与 @Optional 优雅降级、调用完整飞书 API。触发词：飞书、Lark、Feishu、LarkClient、飞书应用、飞书机器人、飞书消息、im.message、开放平台、飞书 SDK。
---

# 飞书（Lark）接入

前置：先加载必读 skill `billy-dev-foundation`（「不重复造轮子」实现查找顺序——飞书调用复用
`LarkClient` 统一入口，不自引 `@larksuiteoapi/node-sdk` / 不自建 Client）。

## 核心要点

- 统一入口 `LarkClient`（`kits/src/lark/lark.client.ts`）：官方 SDK（`@larksuiteoapi/node-sdk`）封装，
  暴露 `raw` 供业务调用完整飞书 API（`im.message.create` 等）。
- 配置 `LarkConfig`（`kits/src/lark/lark.config.ts`）：`appId` / `appSecret` / `domain`
  （`feishu` 国内默认 / `lark` 国际）。
- **可选装配**：`root.module.ts` 仅当 `LARK_APP_ID` + `LARK_APP_SECRET` 都存在才
  `LarkModule.forRootAsync`（config 取 `lark` 命名空间）；依赖方用 `@Optional()` 优雅降级
  （未装配则 undefined）。
- **通知语义归通知模块**：`LarkNotifyClient`（`kits/src/notification/lark-notify/`）注入这层封装发文本消息，
  协议细节在 LarkClient、通知目标与消息形状在 LarkNotifyClient（见 `notification` skill）。
- 用法：构造器 `@Inject(LarkClient)`，业务经 `lark.raw.*` 调 API；别在业务里散落
  `import * as lark` 或自行 `new lark.Client(...)`。

## 完成检查清单

- [ ] 复用 `LarkClient` 统一入口（`@Inject(LarkClient)`），未散落 import 官方 SDK / 未自行 new Client
- [ ] 凭据走 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` 环境变量，未硬编码
- [ ] 依赖 LarkClient 的能力对未装配场景 `@Optional()` 降级，未假设一定存在
- [ ] 发通知优先走 `notification` skill 的 `LarkNotifyClient`，不直接用 `raw` 发消息
