# 能力网关与 common-capability（本地口径：一个进程 = 一个服务）

> **查证优先级：必核** —— 服务名 / 能力数 / 协议字段 / 客户端归属；改网关或服务登记后重核。

## 结论（2026-11-18，本地口径修正）

- **服务 = 一个部署 / 责任单元**：`common-capability` 整体登记为 **`common`**（17 个能力）；
  bash / web / files / memory 只是代码内的能力分组，不是服务身份（协议允许一进程多身份，本地不用）。
- **能力定义用装饰器**：`@CapabilityGroup`（组默认 risk / scope）+ 方法级 `@CapabilityDecl`（入参 zod 内联）；
  注册表 `ToolExecutorRegistry` 用 `scanCapabilities` 扫描绑定（`decl.tool` → 方法），声明缺执行体启动期就抛。
  `defineCapability` / `defineService` 与独立 `capabilities/schemas.ts` 已删（file 域 schema 仍来自 `@repo/ai-data`）。
- **登记 HTTP 只在 `@repo/internal-sdk`** 的 `CapabilityGatewayClient`（register / heartbeat /
  deregisterInstance / deregisterService / list / status / invoke / tasks）；`@repo/capability` 只留
  `CapabilityRegistrar` 生命周期编排，依赖最小接口 `CapabilityRegistrarClient`。
- **key = 扁平工具名**（`bash` / `file-list`）：网关按 key 建索引，跨服务重名登记 409；服务名不拼进 key。
- **`protocol`（capability / mcp）全链路**：契约默认 `capability`、`source:'code' + mcp` 拒收；网关快照落库；
  shared Save/Model、main `toModel`、admin 页 chip 与表单透传。MCP 适配器**待建**：只落标识与目录治理，
  invoke 路由与工具清单同步都还不可用（页面明示，不造假能力）。
- **`inputSchema` 全链路透传**：网关 `CapabilityDeclSchema.inputSchema` → main `toModel` → shared
  `ModelSchema.capabilities[].inputSchema` → admin 参数说明（类型 / 必填 / 默认值；非 object 用 JsonView 兜底）。
- **后台 `/main/ai/capabilities`**：卡片列表 + 按类型给操作（`code` 只给启停 Switch；`manual` 才有编辑 /
  测试连通 / 删除）+ 能力清单居中 Dialog（`sm:max-w-[50vw]`、`h-[80dvh]`、左主从）+ 协议联动表单
  （MCP 填标准配置 JSON）+ 能力只同步不手填 + 双按钮行动行。
- **外部工具进模型面（2026-11-18）**：runtime 从能力目录取 `CapabilityInfo`，对**本地没声明**的工具
  现场造 `ToolSpec`（category `external`，JSON Schema → zod），执行走 `RemoteToolInvoker`；
  agent 声明 `'*'` 或 `EXTERNAL_TOOLS`（`{ external: true }`）才会出现；**子 agent 暂不含外部工具**。
- **MCP 整栈实测（2026-11-19，admin 端）**：会话 `o6gqgsctdw2esg7pky0i` 里模型自主选了 MCP 工具，
  `maps-weather` / `maps-geo`×2 / `maps-direction-driving` / `maps-direction-transit-integrate`，
  审计全 `ok`（93–319ms），时间线有 tool-call/tool-result（output-available）。证明「目录 → 动态工具 → 网关 → MCP」整链通；
  但该会话 owner 是 admin id（isAdmin），用户级隔离仍未做。
- **服务级授权（2026-11-19）**：`ai_service_grants`（admin × manual 服务，服务名不是 id）；
  只作用于 `source='manual'`（外部/MCP），`code` 服务默认全部可用；网关 `listFor/invoke/tool-search`
  按 grant 过滤（5s 缓存）；runtime 目录请求与缓存 key 已补 `userId`；页面 `/main/ai/authorizations`；
  迁移回填存量 admin × 存量 manual 服务；新 manual 服务自动授权给登记人。
- **工具检索（2026-11-19）**：网关内建 `tool-search`（BM25，中文 unigram+bigram，key/title/tags/description 加权），
  只检索**当前身份可见**目录（复用 `listFor`），返回 top-k 的 key/说明/score；零模型调用；runtime 有同名工具。
- **toast viewport `z-[100]`**：全局反馈高于一切浮层（原先 `z-50` 被 Dialog backdrop-blur 糊住）。
- **工具级配置下发（2026-11-18）**：网关调用前读 `ai_tools` 的 config / limits / secrets，
  随 `x-capability-config` 下发（ASCII JSON；非 ASCII 用 `b64:` + base64url）；worker 解码后挂 `request.settings`。
- **后台两项自检 + draft 门槛**：保存先按 `draft` 登记 → 测试连通 + 冒烟调用（`POST /invoke` 回
  `{version, ok}` 即可）→ 双过切 `active`，失败留 draft 并把原因回页面。
- **目录事实源在 DB**：`ai_capability_services`（一行一服务，整条 `RegisteredService` 存 jsonb；迁移
  `AddCapabilityServiceSnapshots`）；重启从 DB 恢复，Redis 仅运行时快照。出站凭据仍单独存 Redis。
- **目标校验（SSRF）**：登记 / 探活 / 调用三处校验——默认 https（http 需 `allowHttp`）、拒绝回环 /
  内网 / 链路本地 / 元数据地址；生产必须 `TOOL_GATEWAY_ALLOW_PRIVATE_NETWORK=false`（开发/测试默认放行内网）。
- **探活 down 不再派发**：`pick()` 对 `probe.state='down'` 返回 null → 调用报 `no-provider`。
- **模型面生效 5s**：runtime 目录 TTL 从 30s 收到 5s（`ai.capability.changed` 事件仍未做，用 TTL 兜口径）。
- 运维：`registrar.stop()` 只注销实例、不删服务记录 —— 切单服务后网关里残留的旧
  exec / web / files / memory 四行要后台删除或 `POST /v1/services/deregister` 清一次。

- **MCP 适配器（2026-11-18，HTTP 型）**：网关做 **client**——兼容两代协议：2025 版 `initialize`（缓存 `Mcp-Session-Id` 5 分钟）与 2026-07-28 无握手 / 无会话版（initialize 回 -32601 / 405 时按无状态继续），每个 POST 带 `MCP-Protocol-Version`；
  → `tools/list`（分页拉全）→ `tools/call`；MCP 工具名归一成扁平 key，原名存声明的 `remoteTool` 调用时传回；
  `isError:true` → `mcp-tool-error`（runtime 归 `upstream`）；后台 MCP 表单可同步清单，保存自检 = 握手 + 列工具；
  stdio / 长连接 SSE 不做；登记只保留一个鉴权 header（多 header 待扩）；MCP 服务**跳过 HTTP 探活**（GET 405 会误判 down），HTTP 超时跟随调用 deadline，`MCP-Protocol-Version` 用协商后的版本。

## 运行态实测（2026-11-18，重启网关 + 服务后）

- `POST /v1/services/list` 只返回一条 `common`（`source=code`、`protocol=capability`、17 个能力、
  1 个实例、`active`）；本机没有残留的 exec / web / files / memory 旧行。
- 17 条能力的 `inputSchema` 都带 `type:'object'`；`bash` 的 properties 是 `[command, cwd]`、
  required 是 `[command]`（与告知里的实测一致）。
- `POST /v1/capabilities/invoke` 用裸名 `bash` 路由到 `common` 实例并返回 `stdout: smoke`。
- MCP 端到端（假 server / DeepWiki / 高德，2026-11-18）：假 server 返回 `echo:hello from gateway`；
  DeepWiki（`mcp.deepwiki.com/mcp`，免鉴权）拉到 3 个工具并返回 React 文档目录；
  高德（`mcp.amap.com/mcp?key=…`，官方 key）拉到 15 个工具（`maps-weather` / `maps-geo` 等），
  北京天气与天安门地址解析都返回真实数据（协议 2025-03-26）。

## 关键位置

| 位置 | 内容 |
| --- | --- |
| `packages/capability/src/decorator.ts` | `@CapabilityGroup` / `@CapabilityDecl` / `scanCapabilities` / `readCapabilityDecl` / `findCapabilityDecl` |
| `packages/capability/src/define.ts` | `CapabilityDefinition` / `ServiceDefinition` / `toInputSchema` / `toRegistration`（无 define 函数） |
| `packages/capability/src/registrar.ts` | `CapabilityRegistrar` + 最小客户端接口 |
| `packages/internal-sdk/src/capability-gateway.ts` | 唯一 HTTP 客户端（含 heartbeat / deregisterInstance） |
| `apps/common-capability/src/capabilities/manifest.ts` | `COMMON_SERVICE` + `buildCommonService(executors)` |
| `apps/common-capability/src/executors/executor.registry.ts` | 扫描绑定 + `isTaskTool` + `definitions()` |
| `apps/common-capability/src/capability.registration.ts` | 单 registrar + `CapabilityGatewayClient` |
| `apps/capability-gateway/src/registry/service.registry.ts` | 登记 / 心跳 / 目录 / 选实例 / 落库（含 protocol） |
| `packages/contracts/src/capability.ts` | 契约（`ServiceProtocolSchema` 等） |
| `apps/main/src/modules/ai-admin/capability/capability.service.ts` | `toModel` 透传 protocol + inputSchema |
| `apps/admin/src/app/(app)/main/ai/capabilities/page.tsx` | 能力服务页（卡片 / 主从清单 / 协议联动） |

## 核对命令

```bash
grep -n "service: 'common'" apps/common-capability/src/capabilities/manifest.ts
grep -rn "@CapabilityDecl(" apps/common-capability/src | wc -l        # 应为 17
grep -n "ServiceProtocolSchema\|protocol" packages/contracts/src/capability.ts | head
grep -rn "defineCapability\|defineService\|CapabilityRegistryClient" apps packages --include=*.ts | grep -v node_modules || echo "已彻底移除"
grep -n "z-\[100\]" packages/ui/src/components/ui/toast.tsx
grep -n "x-capability-config\|b64:" apps/capability-gateway/src/registry/service.invoker.ts
grep -n "status: 'draft'" apps/main/src/modules/ai-admin/capability/capability.service.ts
grep -n "initialize\|tools/list\|remoteTool" apps/capability-gateway/src/registry/mcp.client.ts
curl -s -X POST http://127.0.0.1:9993/v1/services/mcp/list -H "x-internal-token: $TOOL_INTERNAL_TOKEN" -H 'content-type: application/json' -d '{"url":"http://127.0.0.1:9700/mcp","allowHttp":true}'
psql "$DB_URL" -c "select service, jsonb_array_length(snapshot->'capabilities') from ai_capability_services"
grep -n "assertSafeTarget" apps/capability-gateway/src/registry/*.ts
```

## 失效信号

能力定义又回到 define 函数 / 服务再次拆成多个身份 / 服务侧自拼 HTTP /
能力 key 重新带上服务名 / toast viewport 回落 `z-50`；任一出现都要回来改卡片。
