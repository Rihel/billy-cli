# 工具元数据权威：定义在服务（装饰器）→ 网关登记 → runtime 只留模型面

> **查证优先级：必核** —— 路径 / 导入 / 接口名；加能力或改目录后重核。

## 结论（2026-11-18，装饰器 + 扁平 key）

- **定义在服务里**：执行器类上的 `@CapabilityGroup` + 方法级 `@CapabilityDecl`（入参 zod 内联，
  与执行体校验同一份）。`common-capability` 是**一个进程一个服务 `common`**（17 个能力），
  启动时 `toRegistration` 把 zod 转 JSON Schema 后 `POST /v1/services/register` 上报。
  文件域 9 个 schema 仍由 `@repo/ai-data` 提供（server 与 worker 单一来源）。
- **key = 扁平工具名**（`bash` / `file-list`，不含服务名）：网关按 key 建索引，跨服务重名登记 409；
  模型面名字与 key 相同。`defineCapability` / `defineService` 已删，只剩类型与 `toRegistration` / `toInputSchema`。
- **网关是目录权威**：`POST /v1/capabilities/list` 返回 key / name / `inputSchema` / risk / scope / available；
  旧的 `/v1/tools/list|invoke` **已删除**。
- **runtime 的模型面副本**：`apps/agent-runtime/src/modules/ai/tools/definitions/*` 只提供参数与文案；
  远程 key 由 `isRemoteToolKey` 判定（`packages/contracts` 的 `REMOTE_TOOL_KEYS`），执行走
  `CapabilityGatewayClient.invoke`。`GatewayToolCatalog` 用目录做授权 / 开关过滤（30s 缓存，网关抖动 fail-open）。
- **main 后台**：`ai-admin/tool/tool-manifests.ts` 是 `ai_tools` 种子用的 manifest 快照；
  `ai_tools` 仍只存 enabled / limits / config / secrets，不是 schema 来源。
- **`@repo/tool-catalog` 与 `pnpm gen:tool-catalog` 已删除**（2026-11-18）。

## 核对命令

```bash
grep -rn "@CapabilityDecl(" apps/common-capability/src | wc -l     # 17
grep -n "REMOTE_TOOL_KEYS" packages/contracts/src/capability.ts
grep -rn "@repo/tool-catalog\|LEGACY_TO_CAPABILITY\|defineCapability" apps packages --include=*.ts | grep -v node_modules || echo "已彻底移除"
grep -n "isRemoteToolKey" apps/agent-runtime/src/modules/ai/runtime/gateway-capability-catalog.ts
```

## 失效信号

- 又出现一个「承载能力定义的 pkg」→ 本卡失效，回到「定义必须在服务里」的评审结论。
- 网关目录与执行器声明出现两份且不一致 → 说明有人绕过 `@CapabilityDecl` 手写 manifest。
