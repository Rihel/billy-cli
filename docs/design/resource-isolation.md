# 资源隔离设计（v1 单用户）

> **状态**：**暂缓（2026-11-19）**。当前改为「服务级授权」：见 [service-authorization.md](service-authorization.md)。
> 本文保留作为后续做用户/租户隔离时的备选方案，其中 P0 的 userId 链路补齐仍会被服务级授权复用。
>
> **关联**：[capability-protocol.md](capability-protocol.md)（能力协议）、
> [capability-gateway.md](capability-gateway.md)（网关）、[workspace.md](workspace.md)（执行环境）、
> [ai-agent.md](ai-agent.md)（会话/运行）、[ai-usage-stats.md](ai-usage-stats.md)（用量口径）。

## 0. 结论（TL;DR）

1. **主体只有三种**：`platform`（平台自身）、`user`（前台用户）、`admin`（后台管理员）；管理员不是超级用户。
2. **归属只有两级**：`platform | user`。内部 code 服务 = platform，用户登记的服务/凭据 = user。将来加 `project` 是第三种，不改现有表结构语义。
3. **隔离靠"归属列 + 仓储层强制 scope + 全链路 key 带主体"**，不做通用 ACL/RBAC。
4. **fail closed**：缺主体拒绝，不存在隐式 system 权限。
5. **分享只做文件**；能力、记忆、会话永远不可分享。
6. **模型 Key 是平台资源**（v1）；BYO 用户 Key 预留 owner 列，后续再做。
7. 管理员跨用户访问走**只读支持模式**（原因 + TTL + 审计）；代操作需要用户/项目管理员同意，v1 不做。

## 1. 背景与目标

### 1.1 为什么现在要做

- 能力网关引入了**用户/外部登记的服务**（MCP / 外部 `POST /invoke`），但登记记录没有 owner：
  所有用户共享平台凭据、共享目录、共享额度。
- AI 会话目前只有 admin 端在用，`conversation.user_id` 实际存的是 **adminId**；一旦 web 开放聊天，
  `users` 与 `admins` 的 id 会混进同一列，归属、配额、审计全部失真。
- 已经踩过的坑：运行时能力目录缓存 key 只有 `isAdmin + rootAgentKey`，**没有 userId**，会跨用户命中。
- 模型 Key 目前是平台级 key 池，明文存储，没有"谁付费"的归属信息。

### 1.2 目标

- 用户只能读写/执行**自己的**资源；平台资源对所有用户可用；
- 管理员是独立主体，跨用户访问必须显式、可审计；
- 凭据、缓存、队列、搜索、文件 URL 全部按主体隔离；
- 隔离失败时拒绝（fail closed），不是静默放行；
- 给未来的"项目 + 成员 + 授权"留扩展点，但 v1 不实现。

### 1.3 非目标（v1 明确不做）

- 团队/租户/组织层级；
- 通用 ACL / ABAC / 细粒度权限引擎；
- 每用户独立 schema / DB；
- 能力、记忆、会话的跨用户分享；
- 管理员代操作（impersonation）；
- 用户自带模型 Key（BYO）。

## 2. 主体与归属

### 2.1 定义

```ts
/** 资源归属（v1 只有两种；将来加 'project'） */
type Owner =
  | { type: 'platform' }
  | { type: 'user'; id: string }

/** 一次请求/一次执行的主体 */
type Principal =
  | { actorType: 'service' }                       // 内部 code 服务
  | { actorType: 'user'; actorId: string }
  | { actorType: 'admin'; actorId: string }
```

### 2.2 规则

1. **主体只从登录态推导**：接口 DTO 不接受 `owner` / `userId` / `actorId`，服务端覆盖。
2. **admin 是独立主体**：后台自己的会话/偏好归 admin；跨用户访问走支持模式（§5.6）。
3. **内部服务是 platform**：代码声明（`source='code'`）的能力、技能、工具配置、平台模型 Key。
4. **用户登记即 user**：`source='manual'` 的能力服务、凭据、文件、会话、记忆、用量。
5. **缺主体 = 拒绝**：后台任务、恢复、定时任务必须显式携带 principal，不允许"系统权限"兜底。
6. **归属不可由客户端修改**：迁移/转移归属只走后台管理入口（v1 只做平台→用户之外的只读展示）。

### 2.3 会话/运行的身份类型

`conversations` / `runs` / `ai_tool_audit` / 用量 需要记录：

```
actor_type: 'user' | 'admin'
user_id: string        -- 与 actor_type 配对，避免 users.id / admins.id 混用
```

> v1 现状：`conversation.user_id` 存 `ownerId`（用户优先、否则 admin），没有类型。
> 改造时先加 `actor_type`，存量数据按来源回填（admin 端会话 → admin；如已有用户会话 → user）。

## 3. 资源盘点

| 资源 | 归属 | 现状 | 目标 |
| --- | --- | --- | --- |
| 会话 / 运行 / 时间线 / 消息 | user / admin | 有 `user_id`，无 `actor_type`；查询按用户 | 补 `actor_type`；所有查询按主体；后台只读支持模式 |
| 记忆 | user | `user_id` 强制，索引已按用户 | 保持；检索/工具按 user 过滤 |
| 文件（OSS + 工作区） | user；平台示例资源为 platform | `user_id` 可空 | `owner_type/owner_id`；OSS 前缀；预签名 URL 绑定主体 |
| 文件分享 | 文件的显式 grant | 有分享 token | 只做文件；可撤销/过期；不引入能力/记忆分享 |
| 技能 / 工具配置 | platform | 全局 | 保持平台级，用户不可建 |
| 模型 / 模型 Key | platform（v1） | 全局 key 池、明文 | 预留 owner 列；加密；按主体选 key；用量归因 |
| 能力服务（capability / MCP） | platform | **无 owner** | code=platform；manual=user；目录/调用按主体过滤 |
| 能力凭据 | 跟随服务 owner | 服务快照里一条明文 | 独立表 + 加密；按 `(owner, service)` 解析 |
| 用量 / 配额 | user | 全局日聚合 + 维度 | 按 user 记账；按 user 配额/限流 |
| 审计 | platform（可读） | 有 caller | 补 `actor_type/actor_id`；按主体过滤读取 |
| 工作区（执行环境） | 不参与归属 | 会话级沙箱 | 保持；不作为 owner |

## 4. 五层防线

隔离必须每层都做，缺一层就会漏。

### 4.1 入口层

- 鉴权 → `Principal`（user / admin；内部调用为 service）；
- DTO 不接收归属字段；创建/更新时服务端取 principal 写入；
- 列表接口不接受"查所有人"的参数（管理员聚合接口单独走 admin 鉴权）。

### 4.2 仓储层

- 用户资源 **禁止裸 ID 查询**；必须 `findFor(owner, id)` 或在 `findById` 后校验归属；
- 查询条件必须带 owner（组合索引以 owner 开头）；
- 批量/聚合查询同样带 owner；跨用户统计只允许在 admin 聚合接口出现。

### 4.3 运行时 / 能力面

- 运行时信封带完整 principal（actorType + actorId）；
- 能力目录按主体过滤（platform + 本人 user）；
- `invoke` 在网关再做一次归属校验（防绕过目录直接调用）；
- 工具检索（`tool-search`）只检索该主体可见目录；
- 子 agent 沿用父 principal，不重新推导。

### 4.4 基础设施

- Redis key / 缓存 key / SSE 频道 / 队列消息 **必须包含主体**；
- MCP 会话按 `(owner, service)` 隔离；
- 后台任务恢复时从任务记录里取 principal，不取"当前请求"。

### 4.5 存储与输出

- OSS key：`u/<userId>/...`（将来 `p/<projectId>/...`）；
- 预签名 URL 只能签给资源 owner（分享走独立 token）；
- 日志/审计/错误信息不回显他人内容；
- 导出接口只导出本人资源。

## 5. 关键资源设计

### 5.1 能力服务与 MCP（P0，当前最痛）

**归属**

```
ai_capability_services
  + owner_type   varchar(8)  NOT NULL DEFAULT 'platform'  -- platform | user
  + owner_id     varchar(20) NULL                          -- user 时必有
```

- `source='code'` → `platform`，所有用户可见；
- `source='manual'` → `user`、`owner_id=登记人`，仅本人可见/可调；
- 唯一约束：`service` 仍全局唯一；用户登记重名时自动建议后缀（如 `fetch-bob`），
  工具 key 随之带服务名，避免跨用户扁平 key 冲突。

**凭据**

```sql
ai_capability_credentials
  id, owner_type, owner_id, service,
  encrypted text,          -- AES-GCM，环境密钥
  fingerprint varchar(32), -- 便于识别，不回显明文
  created_at, last_used_at,
  UNIQUE(owner_type, owner_id, service)
```

- 登记时写入，接口只回 `hasCredential` / 指纹后四位；
- 服务快照里 **不再存 credential**；
- 调用时按 `(owner, service)` 解密注入。

**目录与调用**

- `listFor(principal)`：`platform` 全放行；`user` 仅 `owner_id === principal.actorId`；
- `invoke` 前同样校验；不匹配返回 403 语义（不暴露服务存在性）；
- runtime 目录缓存 key 加 `actorType + actorId`（当前缺 userId，是已知泄漏点）；
- MCP 会话缓存 key 从 `url` 改为 `(owner, service, url)`；
- `tool-search` 复用 `listFor`，天然收敛。

**登记入口**

- 用户自助：`/ai-capability/my/*`（UserAuthGuard）——列表 / 登记 / 编辑 / 测试 / 同步 / 启停 / 删除；
- admin 后台：保留全部服务**元数据**视图（owner、状态、工具数），不能替用户改凭据；
- 平台托管 MCP（高德这类）：用 **code 声明**接入（`source='code'` + `protocol='mcp'` + 平台凭据），
  当前契约禁止 `code+mcp`，需要放开。

### 5.2 模型 Key

- v1：平台统一采购，`ai_provider_keys` 视为 platform；管理端维护；
- 预留 `owner_type/owner_id`，将来支持 BYO；
- 若做 BYO：
  - 按主体优先选用户 Key，没有才回落平台池；
  - **禁止静默回落**：用户 Key 失效要明确报错；
  - Key 加密、只回指纹；用量按 `(key_owner, caller)` 归因；
  - 用户自定义模型/baseURL 时，模型目录也要按 owner 过滤。
- 分享规则：Key 永远不可分享；项目阶段的"共享 Key"是成员按角色使用，不是分享链接。

### 5.3 文件与分享

- `ai_files` 用 `owner_type/owner_id`；OSS key 前缀带主体；
- 分享是**文件的显式 grant**：token、可撤销、可过期、可限制次数；
- 能力 / 记忆 / 会话**永久不可分享**（产品硬规则，不是 v1 限制）。

### 5.4 用量与配额

- 每次模型调用/能力调用记录 `actor_type + actor_id`；
- 日聚合 + 维度表支持按用户查询（沿用现有 dimension 机制，确认 `user` 维度可用）；
- 配额与限流按 user；平台 Key 的成本按 user 计，平台总账另算；
- 管理员/系统调用单独归类，不混入用户配额。

### 5.5 审计

- `ai_tool_audit` 补 `actor_type/actor_id`；
- 审计读接口：用户只能看自己的；管理员按租户/用户过滤（v1 单用户即可按用户）；
- 支持模式下的访问必须单独记一条审计（谁、何时、看了谁、原因）。

### 5.6 管理员支持模式

- 默认：admin 只能看**元数据**（资源是否存在、状态、用量汇总、错误码）；
- 只读支持：发起支持会话（原因 + TTL，如 30 分钟），可看指定用户的内容；全程审计；
- 写操作：v1 不做；将来要求用户/项目管理员显式同意；
- 目的：运维能排障，但管理员不是隐形超级用户。

## 6. 数据契约与迁移

### 6.1 字段约定

- 用户资源：`owner_type`（`platform|user`）+ `owner_id`（platform 为 null）；
- 唯一约束包含 owner（如 `(owner_type, owner_id, service)`）；
- 索引以 `(owner_type, owner_id, ...)` 开头；
- 凭据一律独立表 + 加密，不随资源快照返回。

### 6.2 迁移步骤（两阶段）

1. 加可空列 / 新表，双写（新数据带 owner；旧数据先不动）；
2. 回填：
   - code 服务 → platform；
   - 存量 manual 服务 → platform（无法确认登记人；当前库里只剩 `common`，影响为零）；
   - 会话 → 按来源回填 actor_type（admin 端 → admin）；
3. 收紧约束（NOT NULL / CHECK），删旧凭据字段；
4. 切换读路径（仓储强制 owner）后再删兼容代码。

### 6.3 回滚

- 加列/建表可回滚；回填数据不可逆，迁移 down 只恢复结构；
- 删除明文 credential 前先确认已加密迁移并抽样校验。

## 7. 隔离测试矩阵（新增资源的准入条件）

每个用户资源至少覆盖：

| 用例 | 期望 |
| --- | --- |
| A 列出资源 | 只看到自己的 + platform |
| A 按 ID 读 B 的资源 | 404 / 403（不泄露存在性） |
| A 更新/删除 B 的资源 | 拒绝 |
| A 搜索（记忆 / 文件 / 工具） | 不出现 B 的结果 |
| A 直接 invoke B 登记的能力 | 拒绝 |
| 缺 principal | 拒绝（fail closed） |
| platform 资源 | A、B 都可见 |
| 缓存 | A 请求后 B 不会命中 A 的缓存条目 |

工程约束：

- 提供两主体测试 helper（`asUser('a')` / `asUser('b')`）；
- 新增用户资源时，PR 必须带上述矩阵的两条核心用例；
- 静态检查/代码审查：仓储层出现"无 owner 查询"直接打回。

## 8. 分期

| 期 | 内容 | 验收 |
| --- | --- | --- |
| **P0** | 主体模型 + `actor_type`；能力服务/凭据 owner 化；目录/调用/缓存/MCP 会话按主体；用户自助登记入口 | 双用户互不可见/不可调；`common` 双方可见；凭据不回显 |
| P1 | 用量/配额按用户；审计补 actor；管理员只读支持模式 | 配额按用户生效；支持访问有审计 |
| P2 | 文件 owner/OSS 前缀/分享 grant；搜索按主体；缓存 key 审计 | 文件跨用户不可读；分享可撤销 |
| P3 | web 会话页 + 模型 BYO Key（如需要） | 双前端会话按主体隔离；BYO Key 不串用 |

## 9. 未来：项目 + 成员 + 授权

v1 只留扩展点，不实现。演进时：

- `Owner` 增加 `{ type: 'project'; id }`；资源表加 `project_id`（可空），支持"个人 ↔ 项目"迁移；
- 项目 = 协作边界：`projects`、`project_members(role: owner|admin|member)`；
- 授权 = 成员 + 角色，不做通用 ACL；
- 会话是否进项目、能力/Key 是否项目共享、用量算谁——**到项目阶段再拍板**；
- 分享规则不变：仍只有文件可分享。

## 10. 对既有设计的修正

| 既有文档 | 原口径 | 本设计 |
| --- | --- | --- |
| capability-protocol §4.1 | 服务 owner = 联系人字符串 | 保留 `owner` 作展示/追责，**新增真实归属** `owner_type/owner_id` |
| capability-protocol §5 | `scope: all/user/admin/agent` | scope 保留为"能力对谁开放"；**归属是另一层**，先过归属再判 scope |
| workspace.md §5.4 | `credentialScope: user/shared` | v1 只支持 user（manual）/ platform（code）；`shared` 留到项目阶段 |
| workspace.md §5.1 | MCP 适配器"尚未实现" | 已实现（HTTP 型）；文档待同步 |
| ai-agent.md | 会话 `user_id` | 补 `actor_type`，禁止 users/admins id 混用 |

## 11. 未决问题

1. 云产品模型费用：平台包月/按量，还是允许用户 BYO Key？（决定 `ai_provider_keys` 是否立刻加 owner）
2. 用户自助登记入口放在设置页还是独立「我的能力服务」页？
3. 管理员支持模式：只读是否已够用？写操作需要谁同意、如何留痕？
4. 存量 admin 会话的 `actor_type` 回填口径（全部 admin，还是有历史用户会话？）
5. 项目阶段：会话是否进项目、共享能力/Key、用量归属。
