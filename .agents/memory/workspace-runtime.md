# AI 工作区执行环境：默认强制隔离、fail closed、会话只能选只读/可写

**查证优先级：必核**（改 `bash` 执行、workspace 配置、沙箱策略前复核）

## 结论

- **Web 产品定位**：隔离是安全底线，不是用户偏好。用户只能选沙箱内的 `fileAccess`
  （`read-only` / `workspace-write`）；"要不要沙箱"是部署配置 `AGENT_WORKSPACE_MODE`。
- 默认 `enforce` + `sandboxNetwork=deny`；沙箱不可用 → **拒绝执行（fail closed）**，
  绝不退回"以服务进程身份跑"（旧版本的 local 兜底已删除）。
- 只有显式 `AGENT_WORKSPACE_MODE=off`（仅自托管）才降级为 `danger-full-access`（宿主进程）。
- 伪造信封里的 `fileAccess` 不会生效：`enforce` 下只认两档允许值，其余按 `workspace-write`。
- **出参 `runtime` / `mode` 是唯一事实**：配置可变、提示词是装配期固定的，只有出参能说明这次在哪跑。

## 坑

- macOS 的 `/tmp` 是 `/private/tmp` 软链：profile 里必须 `realpath`，否则写权限静默不生效（实测）。
- SBPL **后出现的规则覆盖先出现的**；`require-not` 会让 `sandbox-exec` 直接 abort（实测），不要用。
- `normalizeConfig` 必须 `...config` 展开：只返回几个字段会把新增配置项悄悄丢掉（踩过）。
- 新增会话字段要跑迁移（`pnpm db:migrate`），否则 e2e（真实库）整批红。
- 测试构造 `BashTool` 要传 `WorkspaceRuntimeService`（用 `test/helpers` 的 `makeBashTool`），不是 `CommandRunner`。

## 依据

- `docs/design/workspace-runtime.md`（决策矩阵 E1–E9）
- `packages/kits/src/workspace/**`、`apps/server/src/modules/ai/tools/bash.tool.ts`、
  `apps/server/src/modules/ai/api/ai-tool.service.ts`
- 核对：`pnpm --filter @repo/kits exec vitest run test/workspace.test.ts`、
  `pnpm --filter @app/server exec vitest run test/ai-tools/bash.test.ts`

## 失效信号

- 引入 docker / 常驻容器 / 远程 runner；默认执行环境改成 local；沙箱改成可读全盘（去掉凭据 denylist）。
