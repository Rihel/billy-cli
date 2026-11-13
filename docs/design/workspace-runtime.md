# 工作区运行时：命令隔离（web 产品的安全底线）

> **状态：已实现（2026-11-12）**。关联 [`ai-file-manager.md` §5](ai-file-manager.md)、
> [`ai-agent.md` §3.15](ai-agent.md)。
>
> 定位前提：**billy-cli 是给 web 产品用的脚手架** —— 默认值必须安全，边界必须写明白，
> 扩展点必须留出来（因为用的人不一定懂沙箱）。

## 1. 威胁模型（先把话说清楚）

`bash` 执行的是**模型生成的命令**，命令来自用户输入 + 网页内容（可被提示注入操纵）。
在 web 产品里，这台机器上不只有这个用户：数据库密钥、Redis、对象存储凭证、其他租户的
工作区、内网服务、云厂商 metadata，全都在同一条网络路径上。

所以：

| 资产 | 谁负责保护 |
| --- | --- |
| 我们的服务器（密钥 / DB / 其他租户数据 / 内网） | **隔离层**（本模块） |
| 用户的工作区数据 | 会话级目录 + 软删 + 对象存储 |
| 用户本人的电脑 | 不参与执行（web 产品只有浏览器） |

**结论：终端用户只能决定"沙箱内能干什么"，不能决定"要不要沙箱"。**

## 2. 隔离分级与本期位置

| 级别 | 形态 | 挡得住 | 挡不住 |
| --- | --- | --- | --- |
| L0 | 服务进程直接跑 | 无 | 全部 |
| **L1** | 进程沙箱（Seatbelt / bwrap）**← 本期** | 误写、删错目录、写系统路径 | 同 uid 进程干扰、读同机文件、内网、资源耗尽、内核漏洞 |
| L2 | 容器（独立 FS/网络/cgroup/uid） | 跨租户、进程干扰、资源耗尽 | 内核漏洞 |
| L3 | microVM | 内核逃逸 | — |

`L1` 是"挡手滑"，**不是"挡恶意代码"**。多租户 SaaS 应上 L2；本模块的
`WorkspaceRuntimeService` 就是将来挂 L2 的端口（换实现，不动 `bash`）。

## 3. 模式词汇

```ts
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

- `read-only`：不能改工作区（临时目录仍可写 —— 易失，不构成数据破坏）；
- `workspace-write`：可写本会话工作区（会话默认）；
- `danger-full-access`：**以服务进程身份执行**，不做任何隔离。

前两档由**会话**选择（`conversations.file_access`）；第三档是**部署级**开关
（`AGENT_WORKSPACE_MODE=off`），终端用户选不到 —— 界面上根本没有这个入口。

## 4. 决策规则

```
部署策略 = AGENT_WORKSPACE_MODE（默认 enforce）

enforce：
  会话 fileAccess（read-only / workspace-write）
    ├─ 沙箱可用 → 在对应模式下执行
    └─ 沙箱不可用 → **拒绝执行**（fail closed），命令一条都不跑
off（仅自托管）：
  整条执行降级为 danger-full-access（宿主进程），出参如实标注
```

三条铁律：

1. **fail closed**：隔离不可用就拒绝，绝不"悄悄退回宿主"——那是把服务器交给不可信用户；
2. **用户选不到出沙箱**：伪造信封里的 `fileAccess` 也不会被执行成 `danger-full-access`
   （`enforce` 下只认两档允许值，其余一律按 `workspace-write`）；
3. **状态可见**：出参带 `runtime` / `mode`，`/info` 与管理页展示部署策略与沙箱能力。

## 5. 决策矩阵（验收用例）

| # | 部署模式 | 会话选择 | 沙箱探测 | 结果 | 出参 |
| --- | --- | --- | --- | --- | --- |
| E1 | `enforce` | 未选（默认可写） | ✓ | 沙箱内执行 | `runtime=sandbox, mode=workspace-write` |
| E2 | `enforce` | `read-only` | ✓ | 沙箱内执行，工作区只读 | `runtime=sandbox, mode=read-only` |
| E3 | `enforce` | 任意 | ✗ | **拒绝执行**（不跑命令） | `ok=false` + 原因 |
| E4 | `enforce` | 伪造 `danger-full-access` | ✓ | 按 `workspace-write` 执行 | `runtime=sandbox, mode=workspace-write` |
| E5 | `off` | 任意 | ✗/✓ | 宿主进程执行 | `runtime=local, mode=danger-full-access` |
| E6 | 任意 | 任意 | 探测超时 | 同 E3 | 同 E3 |

## 6. 平台与默认值

| 平台 | 后端 | 说明 |
| --- | --- | --- |
| macOS | `sandbox-exec`（Seatbelt） | 工作区可写（或只读）、凭据目录禁读、临时目录可写 |
| Linux | `bwrap` | 整机只读挂载 + 工作区按模式 bind；需 unprivileged userns |
| Windows | 无 | 恒不可用 → `enforce` 下命令被拒绝（要沙箱请部署到 WSL2 / Linux） |

默认值（`.env.example`）：

```env
AGENT_WORKSPACE_MODE=enforce            # 默认强制隔离，fail closed
AGENT_WORKSPACE_SANDBOX_NETWORK=deny    # 默认断网：同 Pod 的 DB / Redis / metadata 摸不到
AGENT_WORKSPACE_PROBE_TIMEOUT_MS=2000
```

`bash` 本身仍然默认关闭（`AGENT_COMMAND_ENABLED=false`）：打开它是操作员的第二次显式授权。

## 7. 会话页与控制台

- **会话页**：只给"只读 / 可写"两个选项（`SegmentedControl`），切换落库并记一条时间线事件
  （`conversation_file_access_changed`），随每一轮进运行时信封；
- **AI 工具配置页**：不再提供"执行环境"下拉，只展示**只读能力**（沙箱可用 / 不可用 / 部署已关闭隔离）；
- `bash` 出参：`runtime`（sandbox / local）+ `mode`（三档），模型与审计都能看到实际边界。

## 8. 路径边界

沙箱内工作区路径 = 宿主路径（同构），因此文件工具、预览、`bash` 看到的是同一份字节。
模型可见路径统一为工作区相对路径；绝对路径只在服务端内部使用。

## 9. 可观测

`GET /info` 的 `workspace` 段：

```json
"workspace": {
  "mode": "enforce",
  "fileAccessOptions": ["workspace-write", "read-only"],
  "sandbox": { "available": true, "impl": "seatbelt", "code": null, "message": null }
}
```

日志：`workspace.runtime.ready`（启动探测）、`workspace.runtime.rejected`（fail-closed 拒绝，
warn，含理由码）。

## 10. 已知边界与下一步

- **L1 不是安全边界**（见 §2）：多租户必须上 L2 容器，端口已留好；
- **网络只有开关**：要 `npm install` 就得 `allow`，没有域名白名单；下一步做代理白名单；
- **无资源隔离**：L1 挡不住 fork 炸弹 / 磁盘打满，靠 L2 的 cgroup；
- **升级闭环未做**：业界做法是"沙箱失败 → 申请单次升级 → 用户批准"，
  我们目前只有会话级选择（`read-only` / `workspace-write`）。

## 11. 实现落点

| 位置 | 内容 |
| --- | --- |
| `packages/kits/src/workspace/` | `workspace.types.ts`（模式 / 能力 / 理由码）/ `workspace.config.ts`（`WorkspaceConfigSchema` + token）/ `workspace.sandbox.ts`（探测 + 包装，seatbelt + bwrap）/ `workspace.runtime.ts`（`WorkspaceRuntimeService`）/ `workspace.module.ts` / `index.ts` |
| `packages/kits/test/workspace.test.ts` | E1–E5 + 探测判据 + 策略构造 |
| `apps/server/src/app-config.ts` | `workspace` 命名空间（`AGENT_WORKSPACE_*`） |
| `apps/server/src/database/entities/conversation-entity.ts` | `file_access`（varchar(16)，默认 `workspace-write`） |
| `apps/server/src/modules/ai/tools/bash.tool.ts` | 会话权限 → 运行时（`runtime.exec({ ..., fileAccess })`）；出参 `runtime` / `mode` |
| `apps/server/src/modules/ai/api/ai.controller.ts` | `POST /agent/conversation/file-access` |
| `apps/admin/src/app/(app)/(standalone)/main/ai/chat/chat-conversation.tsx` | 会话页「只读 / 可写」（`SegmentedControl`） |
| `apps/admin/src/app/(app)/main/ai/tools/config-panels.tsx` | 只读隔离能力提示 |
| `apps/server/src/modules/ops/ops.controller.ts` | `/info` 的 `workspace` 段 |

补充（2026-11-13 核对）：

- `WorkspaceRuntimeService.exec()` **永不抛异常**：策略拒绝、沙箱不可用、沙箱构造失败都落成
  `ok=false` 的结论（`blocked()`），命令一条都不跑；
- `status()` 的 `fileAccessOptions` 在 `enforce` 下固定为 `['workspace-write', 'read-only']`，
  `off` 下为空数组 `[]`（没有隔离就没有「文件权限」可谈）；
- `modeOf()`：`off` 一律 `danger-full-access`；`enforce` 下只认 `read-only`，**其余任何值
  （含伪造的 `danger-full-access`）都落到 `workspace-write`**；
- `/info` 的 `workspace.sandbox` 是**扁平化**后的四个字段（`available` / `impl` / `code` /
  `message`），不是 `SandboxCapability` 原样（原始还有 `binary` / `reason` / `probedAt`）；
- 探测超时配置键是 `probeTimeoutMs`（env `AGENT_WORKSPACE_PROBE_TIMEOUT_MS`，默认 2000），
  联网策略是 `sandboxNetwork`（env `AGENT_WORKSPACE_SANDBOX_NETWORK`，默认 `deny`）。

## 12. 决策记录

| 事项 | 结论 | 日期 |
| --- | --- | --- |
| 开关粒度 | **会话级**，但只限沙箱内（只读 / 可写）；出沙箱是部署配置 | 2026-11-12 |
| 默认值 | `enforce` + 断网；`bash` 默认仍关闭 | 2026-11-12 |
| 沙箱不可用 | **拒绝执行**（fail closed），不退回宿主 | 2026-11-12 |
| 自托管逃生门 | `AGENT_WORKSPACE_MODE=off`，仅部署方可见 | 2026-11-12 |
| 未做 | L2 容器、网络白名单、单次升级审批、资源限额 | — |
