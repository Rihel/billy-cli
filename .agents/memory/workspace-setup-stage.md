# 工作区初始化阶段（P5 + 技能集合版本）

**查证优先级：必核**（改 workspace-service 启动流程 / 实体注册 / env 注入前复核）

## 结论（2026-11-23）

- **位置**：`apps/workspace-service/src/workspace/setup/setup.service.ts`，由 `WorkspaceRuntime` 在 handle
  **首次创建后**调用（`setupDone` 只跑一次），顺序固定：
  ① 按清单装包并 `verify`（已过则 skipped）→ ② 物化技能到 `.agents/<key>/` → ③ 落地凭据（文件 600 + env）
  → ④ 写 `.billy/setup.json`、`.billy/credentials.json`。
- **幂等**：`.billy/setup/<setupId>@<hash>.done`；hash 覆盖**安装项 + 技能内容**（凭据每次 ensure 重落）。
  技能没写全（partial / failed）**不写 done 标记**，避免一次瞬时失败被永久固化。
- **技能集合版本**（issue 3）：`skillSetVersion` = 可见技能 `key + contentHash` 排序后 sha256 前 16 位。
  `setup.json` 记录，`syncSkillsIfStale` 比对落后才物化；**技能没写全不记新版本**，幂等命中沿用旧值。
  补的是「技能建时工作区没在跑」「main 推送丢一次」两个洞（推送只推运行中、初始化只在新容器跑）。
- **冷路径**（issue 5）：补凭据 / 技能版本比对 / 物化走 `runInBackground`（`workspaceId:任务` 单飞），
  **不 await 在第一条 fs 请求上**；host 首次初始化也放后台。`SetupShell.writeMany` 把多个小文件拼一条
  exec（单条 >48KB 退回分片 `write`），容器后端不再是「每文件 2–4 次 docker exec」。
- **写文件约束**：`SetupShell.write` 的 `mode` 是**权限位值**（`0o600`），不是十进制 600 —— 后者在 host
  会写成 `0o1130`（无读位）。exec shell 用 `mode.toString(8)` 生成 `chmod 600`，两边语义一致。
  host 的 `~` 展开**真实 HOME**（`allowHome = features.writeHome`），HOME 已有文件不覆盖（保护用户登录态）。
- **凭据段补偿**（issue 9）：`materializeCredentials` / `run` / `syncCredentials` 透传 `resolved`；
  handle 记 `credentialsReady`（认领来的标 `false`）。命中旧 handle 且 false 时只重跑凭据段；
  初始化失败另排 5s 定时补偿（unref，成功自停）。安装失败不重试（贵），凭据失败必须重试（便宜）。
- **实体注册**：workspace-service 只登记它读的表；`listVisibleSkills` 查 `ai_skill_grants`，
  漏登记会让初始化被 try/catch 吞成 warn（看似正常）→ 凭据从头就没落地。`entity-registration.test.ts` 钉死。
- **清单读取必须 JSON.parse**：`fs read` 出参是 `{ path, content, bytes }`；直接当结构用会永远读空，
  并缓存成阴性结果（一次"成功"即永久拒绝）。读失败不缓存、拒绝前重读一次磁盘。
- **技能物化单文件失败不连坐**：`SKILL.md` 先写；批量写失败退回逐个写，精确到文件记 partial。

## 依据

- `docs/design/workspace-cli-credentials.md` §6.2 / §6.3 / §6.4.3 / §6.7.4
- 核对：
  ```bash
  pnpm --filter @app/workspace-service test
  grep -n "skillSetVersion\|syncSkillsIfStale\|runInBackground" apps/workspace-service/src/workspace/setup/setup.service.ts apps/workspace-service/src/workspace/workspace-runtime.service.ts
  grep -n "writeMany\|allowHome" apps/workspace-service/src/workspace/setup/shell.ts
  grep -n "entities" -A 10 apps/workspace-service/src/root.module.ts
  ```

## 失效信号

初始化挪到 main / 依赖缓存与快照落地 / env 注入改成逐条命令 RPC / 技能物化按 owner 过滤（P9）后需重核本文口径。
