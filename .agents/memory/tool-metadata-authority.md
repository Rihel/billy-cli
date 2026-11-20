# 工具元数据权威：定义在服务（装饰器）→ 网关登记 → runtime 只留模型面

> **查证优先级：必核** —— 路径 / 导入 / 接口名；加能力或改目录后重核。

## 结论（2026-11-18，装饰器 + 扁平 key）

- **定义在服务里**：执行器类上的 `@CapabilityGroup` + 方法级 `@CapabilityDecl`（入参 zod 内联，
  与执行体校验同一份）。`common-capability` 登记服务 `common`（声明 17、实际登记 9；bash + 7 个工作区
  文件由 `workspace-service` 登记为 `workspace` 8 个），网关内建 3 个；合计 **20 个 code 能力**。
  文件域 9 个 schema 仍由 `@repo/ai-data` 提供（server 与 worker 单一来源）。
- **key = 扁平工具名**（`bash` / `file-list`，不含服务名）：网关按 key 建索引，跨服务重名登记 409；
  模型面名字与 key 相同。`defineCapability` / `defineService` 已删，只剩类型与 `toRegistration` / `toInputSchema`。
- **网关是目录权威**：`POST /v1/capabilities/list` 返回 key / name / `inputSchema` / risk / scope / available；
  旧的 `/v1/tools/list|invoke` **已删除**。
- **runtime 不再留模型面副本**（2026-11-20）：`tools/definitions/*` 与本地执行体已删；
  `resolveTools` 直接按目录建工具（`source='code'` 随工具面下发，`manual` 搜到才下发），
  提示词首轮从目录渲染。`GatewayToolCatalog` 缓存 5s，网关抖动 fail-open。
  代价：能力 key 的拼写不再在启动期报错（目录是运行期数据）。
- **main 后台（2026-11-20 起）**：`tool-manifests.ts` 快照已删；工具清单元数据问执行面
  （`POST /internal/agent/tools`）与能力网关（`/v1/capabilities/list`），`ToolAdminCatalog` 5s 缓存、两边不可用只降级。
  `ai_tools` 仍只存 enabled / limits / config / secrets。
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
