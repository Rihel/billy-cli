# 配了目录的工作区（local 后端的 `location.root`）

**查证优先级：必核**（改工作区根解析、local 后端、初始化阶段前复核）

## 结论

- 工作区根只有两种形态：**平台托管** `<WORKSPACE_LOCAL_ROOT>/<workspaceId>`（默认、跑初始化），
  与**宿主目录** `location.root`（用户给的绝对路径、**不跑初始化**）。
- 宿主目录的三道闸（`apps/workspace-service/src/workspace/host-root.ts`）：
  ① 落在 `WORKSPACE_LOCAL_ALLOWED_ROOTS` 内（不配 = 关闭，不是默认放行）；② 不覆盖凭据 denylist；
  ③ 沙箱必须 `enforce`（`AGENT_WORKSPACE_SANDBOX=false` 时拒绝）。
- main 只做**语法**校验（绝对路径 / 不是 `/` / 不含 `..`）：main 与 workspace-service 可能不在一台
  机器上，存在性与允许根只能由看得到宿主文件系统的一方（执行面）校验。
- 初始化按**执行环境声明**（`WorkspaceFeatures`）分流（2026-11-22 起）：技能两种 Host 形态都物化到 `.agents/`
  （Node fs 直写，Windows 也能跑）；装包与凭据按 `installGlobal` / `writeHome` 跳过，不写宿主 HOME、不写凭据清单。
  技能目录带 `.billy-skill` 标记，收敛只删带标记的目录（避免误删用户仓库里的 `.agents/*`）。

## 坑

- `local` 的 `file-*` 能力**不经沙箱**（直接以服务进程身份读写，只做「工作区内」判断）：
  所以允许根是唯一范围限制，别改成「任意绝对路径」。
- 沙箱开关：`AGENT_WORKSPACE_SANDBOX=true|false`（旧键 `AGENT_WORKSPACE_MODE=off` 等价），
  代码里读 `SandboxRuntime.sandboxEnabled`（`mode` 是派生的 'enforce'/'off' 展示值）。
- 驱动可按工作区指定：`ai_workspaces.driver`（`host` / `docker` / `kubernetes`；空 = 按 backend 与部署默认推导），驱动按需创建并缓存。
- 沙箱模式要从 `SandboxRuntime.mode`（kits 新增的 getter）读，不要自己再读 `process.env`：
  两边取值不一致时会出现「配置 off 却以为 enforce」。
- 声明与实现的事实源：`packages/contracts/src/workspace-env.ts` + `apps/workspace-service/src/workspace/features.ts`；
  工具/初始化/提示词只读声明，不读 backend。
- 改 `@repo/shared` / `@repo/kits` 的源码后必须先 `pnpm --filter <pkg> build`：包的 exports 是
  `import → dist/*.mjs` + `types → src`，TS 会就近取 `dist/*.d.mts`，不重建时新字段在 typecheck 里
  「不存在」（2026-11-22 实测）。

## 执行环境信息（2026-11-22 起）

- workspace-service 暴露惰性查询 `POST /v1/workspaces/environment`（只读配置：根 / 托管标志 / 文件权限 / 声明），
  不探测、不建环境；
- agent-runtime 首轮通过 `WorkspaceEnvironmentClient`（`WORKSPACE_SERVICE_URL` / `WORKSPACE_INTERNAL_TOKEN`）
  取一次，渲染进 `partials/environment`（根 / 语法 / 隔离与网络 / 资源 / 持久 / 文件权限）；**查不到整段省略**，
  不阻断问答；只在首轮注入（系统提示是请求前缀，不能每轮变）。

## 建工作区（2026-11-22 起）

- 用户只填名称：存哪由部署配置 `WORKSPACE_DEFAULT_DRIVER`（host / container / pod）决定，
  `WORKSPACE_DEFAULT_DRIVER` 决定；界面只显示「会保存在哪」（`POST /ai-workspace/defaults`）。
- 驱动创建时定死：`update` 只接受当前值，换驱动 = 换环境（数据不迁移），只能新建工作区；界面不提供改驱动入口。

## 驱动层（2026-11-22 起）

- `environment/types.ts`：`WorkspaceDriver`（probe / prepare / exec / fs / dispose）与 `DriverRef`（root / managed / containerName）。
- `environment/host.driver.ts`：沙箱执行 + Node fs；`stop` 保留目录，`purge` 才删。
- `environment/container.driver.ts`：docker / k8s 共用一套（起环境时做镜像比对重建、exec 翻译出参、fs 命令翻译、dispose 删容器）。
- 运行时只做坐标解析（`resolveEnvironmentOf`）/锁/回收/初始化，不再按 backend 分叉 exec/fs。

## 文件组织（2026-11-22 起）

- `workspace-service/src/workspace/` 按职责分：`fs/`（host-fs / container-fs / find-tree / path / tmp）、
  `exec/`（env / output）、`setup/`（setup.service / shell / pure）、`container/`（driver）、
  `credential/`（gate / client / import / save / cli-adapters）；runtime 只做流程。
- 环境变量注入：`withEnvPrefixFor(shell, command, env)`（`sh` 用 `env … sh -c`，`cmd` 用 `set "K=V" && …`）。
- 技能列举：`SetupShell.listDirs`（Host 用 `readdir`，容器用 `ls -1p`）。

## 一致性与排障

- fs 语义由 `test/fs-contract.test.ts` 收口：同一组用例跑 `hostFs` 与 `containerFs`（假执行器把容器命令翻译成真实 fs）。
  已知约定：`list` 只给 name/path/type（path 相对工作区根），大小与时间用 `list-tree`。
- `GET /info`：平台画像 / 沙箱状态 / 容器运行时 / localRoot 与白名单（排障先看这个）。
- `POST /v1/workspaces/environment`：单个工作区的声明（提示词与后台用）。

## 依据

- `apps/workspace-service/src/workspace/host-root.ts`、`workspace-runtime.service.ts`（`localRootPlan`）
- `apps/main/src/modules/ai-admin/workspace/workspace.service.ts`（`normalizeHostRoot`）
- `packages/shared/src/schema/workspace.schema.ts`（`root`）、`docs/design/workspace.md` §3.1.1
- 核对：`pnpm --filter @app/workspace-service exec vitest run test/host-root.test.ts`、
  `pnpm --filter @app/main exec vitest run test/workspace-host-root.test.ts`

## 失效信号

- 容器 / k8s 后端开始支持挂宿主目录；允许根改默认放行；初始化不再往工作区写 `.billy` / `.agents`。
