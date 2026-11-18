# 服务级授权设计（v1）

> **状态**：设计稿（2026-11-19）。本轮只做「管理员 × 外部服务/MCP」的**服务级授权**；
> 不做用户隔离、不做能力级授权、不改 `admins` 表。深度身份认证与访问控制（角色/租户/策略）后续再演进。
>
> **关联**：[capability-protocol.md](capability-protocol.md)、[capability-gateway.md](capability-gateway.md)、
> [workspace.md](workspace.md)、[resource-isolation.md](resource-isolation.md)（暂缓）。

## 0. 结论

1. **自建协议服务（`source='code'`）默认全部可用**，不查授权；
2. **外部服务 / MCP（`source='manual'`）必须被授权**才能出现在目录、被调用；
3. 授权粒度 = **服务**（不是能力）；表里存**服务名**（`common` / `amap`），不存内部 id；
4. **任何管理员都能授权**（`admins` 表不加 `is_super`）；后续做深度访问控制时再引入角色/策略；
5. 授权是**允许列表**：没有记录 = 不可用。

## 1. 数据模型

```sql
ai_service_grants
  id             varchar(20)  PK
  principal_type varchar(8)   NOT NULL DEFAULT 'admin'  -- admin（预留 user / role）
  principal_id   varchar(20)  NOT NULL                   -- admin id
  service        varchar(64)  NOT NULL                   -- 服务名
  granted_by     varchar(20)  NULL                       -- 哪个管理员授的
  created_at, updated_at
  UNIQUE(principal_type, principal_id, service)
  INDEX(principal_type, principal_id)
  INDEX(service)
```

- 只对 `source='manual'` 的服务写入；`code` 服务即使被写入也不生效（网关直接放行 code）。
- `principal_type` 现在固定 `admin`；将来支持用户/角色授权时直接复用，不换表。
- 服务名是协议级稳定标识；当前没有"服务改名"入口，若将来支持改名，在同一事务里同步 `service` 列。

## 2. 默认值与迁移

| 场景 | 默认 |
| --- | --- |
| 存量管理员 | 迁移时对**存量 manual 服务**补授权（当前即 `amap`），保证上线后可用 |
| 新管理员 | 默认 0 个 manual 服务（code 服务不受影响） |
| 新 manual 服务 | 自动授权给登记它的管理员 |
| code 服务 | 不参与授权，所有管理员/用户可用（仍受 scope/agent 约束） |

迁移 SQL 在 `AddServiceGrants` 里：`admins × ai_capability_services` 且 `snapshot->>'source'='manual'`。

## 3. 生效链路

```
runtime 目录请求（带 userId）
  → 网关 listFor({ isAdmin, userId, agentKey, rootAgentKey })
      → code 服务：放行（再判 scope/agent）
      → manual 服务：必须存在 grant('admin', userId, service)
  → invoke：同样校验，未授权 → forbidden（不暴露服务是否存在）
  → tool-search：复用 listFor 的结果，自动收敛
```

要求：

- runtime 的 `ToolCallerIdentity` 与目录缓存 key **必须带 userId**（当前缺，是跨管理员串目录的缺口）；
- `CapabilityListRequest.caller.userId` 由 runtime 填入（管理员登录态即 admin id）；
- 网关授权查询 5s 缓存；授权变更最多 5s 生效。

## 4. 接口与页面

main（`AdminAuthGuard`，任何管理员可调）：

```
POST /ai-capability/grants/list   → { grants: [{ adminId, service, grantedBy, createdAt }] }
POST /ai-capability/grants/set    → { adminId, services: string[] }   覆盖式设置
```

页面：`/main/ai/authorizations`（「服务授权」）：

- 左/上：管理员列表（邮箱、姓名）；
- 右侧：该管理员可用的 manual 服务勾选（code 服务只读展示为"默认可用"）；
- 任意管理员可修改任意管理员的授权；
- 服务列表来自能力服务目录，只展示 `source='manual'`。

## 5. 边界与非目标

- **不做**：用户隔离、能力级授权、服务 owner、BYO 凭据、按租户/角色授权；
- **不做**：deny 规则（只有允许列表）；
- 未授权服务的工具在目录、工具检索、invoke 三处都不可见/不可用；
- 管理员对自己也走同一套授权（默认给自己勾选即可）。

## 6. 验收

1. 存量 admin 能继续用 `amap`（迁移补授权）、`common` 不受影响；
2. 新建 admin：`common` 可用、`amap` 默认不可见；授权后可见可调；
3. 未授权直接 `invoke` → `forbidden`；`tool-search` 不返回未授权服务；
4. 授权页面任意管理员可改，保存后 ≤5s 生效；
5. 网关单测覆盖 code/manual 两条路径；main 覆盖 set 校验（code 服务拒绝写入）。

## 7. 后续（深度身份与访问控制）

- `principal_type` 扩展 `user` / `role`，支持用户级与角色级授权；
- 引入角色（租户管理员 / 运维 / 只读）与策略（allow/deny、条件）；
- 审计：授权变更记录 `granted_by` 与时间（表已有），操作日志可查；
- 若做租户，再在服务与授权上加 `tenant_id`，不改变本表的语义。
