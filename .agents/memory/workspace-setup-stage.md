# 工作区初始化阶段（P5）

**查证优先级：必核**（改 workspace-service 启动流程 / 实体注册 / env 注入前复核）

## 结论（2026-11-20）

- **位置**：`apps/workspace-service/src/workspace/workspace-setup.service.ts`，由 `WorkspaceRuntime.ensureHandle`
  在 handle **首次创建后**调用（`setupDone` 保证只跑一次），顺序固定：
  ① 按清单装包并 `verify`（已通过则 skipped，命中依赖缓存就是这个表现）→ ② 物化技能到 `.agents/<key>/`
  → ③ 落地凭据（文件 600 + env）→ ④ 写 `.billy/setup.json`、`.billy/credentials.json`。
- **幂等**：`.billy/setup/<setupId>@<hash>.done`；hash 只覆盖**安装项 + 技能内容**（凭据每次 ensure 重新落地）。
  包清单 = owner 的 `default` 清单（或 `setup_id` 指定）+ 工作区 `setup_extra` 去重合并。
- **凭据**：执行面不持密钥，走 `POST /internal/credentials/resolve`（main，`TOOL_INTERNAL_TOKEN`），
  拿到明文后按 inject 规则渲染；模板支持 `${config.x}` / `${secret.x}`，字段缺失**整条规则失败**（不写半截）。
- **env 注入**：初始化返回的 env 缓存在 handle 上，每条 `exec` 合并进请求；local / k8s 用
  `env 'K=V' ... sh -c '<整条命令>'`（**不能只加前缀**，前缀只作用于第一条命令，`a && echo $K` 拿不到值）。
- **实体注册**：workspace-service 的 `DbModule` 只登记它读的表（工作区 / 会话 / 清单 / 技能 / 技能文件 / 凭据名）；
  加新的初始化查询必须同步补 `entities`，否则运行期报 `No metadata for "XxxEntity"`。
- **local 后端注意**：`~/.my.cnf` 这类注入路径会落到**宿主 $HOME**（local = 自托管单租户）；容器后端写在容器内。
  云端多租户必须用 container / k8s 后端。

## 依据

- `docs/design/workspace-cli-credentials.md` §6.2 / §6.3 / §6.4.3
- 核对：
  ```bash
  pnpm --filter @app/workspace-service test
  grep -n "entities" -A 8 apps/workspace-service/src/root.module.ts
  ```

## 失效信号

初始化挪到 main / 依赖缓存与快照落地 / env 注入改成逐条命令 RPC / 技能物化按 owner 过滤（P9）后需重核本文口径。
