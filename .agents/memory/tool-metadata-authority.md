# 工具元数据权威：定义在服务（zod）→ 网关登记 → runtime 只留模型面

> **查证优先级：必核** —— 路径 / 导入 / 接口名；加能力或改目录后重核。

## 结论（2026-11-18，能力网关改造后）

- **定义在服务里**：`common-capability/src/capabilities/{manifest,schemas}.ts` 用 zod +
  `defineCapability` 声明（exec / web / files / memory 四个身份，17 个能力），启动时转
  JSON Schema 并 `POST /v1/services/register` 上报。文件类 schema 由 `@repo/ai-data`（文件域）提供。
- **网关是目录权威**：`POST /v1/capabilities/list` 返回规范 key（`服务名/工具名`）、
  模型面名字（`服务名__工具名`）与 `available`；旧的 `/v1/tools/list|invoke` **已删除**。
- **runtime 的模型面副本**：`apps/agent-runtime/src/modules/ai/tools/definitions/*` 只提供参数与文案，
  执行走 `CapabilityGatewayClient.invoke`（旧 key → 规范 key 用 `LEGACY_TO_CAPABILITY` 32 条别名）。
- **main 后台**：`ai-admin/tool/tool-manifests.ts` 是 `ai_tools` 种子用的 manifest 快照；
  `ai_tools` 仍只存 enabled / limits / config / secrets，不是 schema 来源。
- **`@repo/tool-catalog` 与 `pnpm gen:tool-catalog` 已删除**（2026-11-18）。

## 核对命令

```bash
grep -n "defineCapability\|CAPABILITY_TO_EXECUTOR" apps/common-capability/src/capabilities/*.ts
grep -n "LEGACY_TO_CAPABILITY" packages/contracts/src/capability.ts
grep -rn "@repo/tool-catalog" apps packages || echo "已彻底移除"
grep -n "capabilityToLegacyKey" apps/agent-runtime/src/modules/ai/runtime/gateway-tool-catalog.ts
```

## 失效信号

- 又出现一个「承载能力定义的 pkg」→ 本卡失效，回到「定义必须在服务里」的评审结论。
- 网关目录与 service 定义出现两份且不一致 → 说明有人绕过 `defineCapability` 手写 manifest。
