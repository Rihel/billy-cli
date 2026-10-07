# codegraph 详解（codegraph 引用文件）

> 本文件是 `codegraph` skill 的组成部分，由主 SKILL.md 引用。
> 接入 / 首次使用 / 查命令时必读。

## 1. 安装与接入（开发者本机手动，**不会自动装**）

> **不自动**：codegraph 是全局 CLI + 本地索引，二者都不入仓库，`pnpm bootstrap` 也不含此步。
> 新环境 / 新 agent 必须**手动**执行下面 1–3 步才可用（仓库里只有本 skill 与新 `.gitignore` 规则）。

> **捷径**：`pnpm codegraph:setup` 一条命令完成第 1 + 2 步（已装则自动跳过 CLI 安装）。

1. **装 CLI**（二选一）：
   - `npm i -g @colbymchenry/codegraph`（**推荐**：国内网络走 npm 镜像，实测 2s 装完）
   - `curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh`
     —— 走 GitHub Releases CDN，**国内网络常超时不通**（实测连 HEAD 都超时），故优先 npm
2. **建索引**：仓库根 `codegraph init`（生成 `.codegraph/`，同一步建全图）。
3. **接 agent（MCP）**：`codegraph install` 能自动配置 Claude Code / Codex / Cursor 等，但
   **不支持 DeepSeek Harness**（DSH 不在其 target 列表里）。DSH 需手动接入：在
   `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里加一条 `insert`（临时试可用
   `dsh web --patch <file.yml>`）；换项目只改 `--path` 与 `cwd` 两处：

   ```yaml
   - insert:
       - id: mcp-codegraph
         name: '@deepseek-ai/dsh-mcp-client'
         config:
           serverName: codegraph
           transport: stdio
           command: codegraph
           args: [serve, '--mcp', '--path', <被索引的项目根>]
           cwd: <被索引的项目根>
   ```

   接上后模型工具列表里出现 `mcp__codegraph__codegraph_explore`（该 server 只暴露这一个工具）。
   **必须显式给 `--path`**：MCP 子进程继承的是 DSH host 进程的 cwd（未必是本仓库），不给会索引
   错项目。改完 patch 用 `dsh --profile <name> --dump-config` 校验合并结果（不启动服务）。
   未接 MCP 时用 CLI 命令（经 bash）同样可用。
4. 升级 `codegraph upgrade`；看图 `codegraph ui`（浏览器 `http://127.0.0.1:4747`）。

> **索引同步有前提**：只有 `codegraph serve --mcp`（默认带文件 watcher，`--no-watch` 才关）或
> daemon 在跑时，改代码才会自动进索引。未接 MCP / daemon 时索引会**静默过期**（实测落后一天多，
> agent 据此读到旧代码），此时改完代码须手动 `codegraph sync`，并用 `codegraph status` 查看
> Added / Modified 待同步文件。`.codegraph/` 已在 `.gitignore` 排除。

## 2. CLI 速查

| 命令 | 用途 |
| --- | --- |
| `codegraph query <q>` | 按名称 / 语义搜索符号 |
| `codegraph node <symbol\|file>` | 读一个符号的源码 + 调用者，或读文件（带行号） |
| `codegraph callers <symbol>` | 谁调用它（反向依赖） |
| `codegraph callees <symbol>` | 它调用谁 |
| `codegraph impact <symbol>` | 改动它的影响半径 |
| `codegraph affected [files...]` | 受改动影响的测试文件（可 `git diff --name-only \| codegraph affected --stdin`） |
| `codegraph files [path]` | 文件结构 |
| `codegraph status` / `sync` / `index` | 状态 / 手动同步 / 重建 |

## 3. MCP 工具

接 MCP 后主要用 `codegraph_explore`（单个工具，一次调用返回相关符号的逐字源码 + 调用路径 +
影响面摘要）。其余工具（node / search / callers / callees / impact / files / status）默认隐藏，
可用 `CODEGRAPH_MCP_TOOLS` 环境变量开放。

## 4. 配置 `codegraph.json`（仓库根，可选，提交共享）

默认已排除 `node_modules` / `dist` / `.next` 等并遵循 `.gitignore`。需要额外排除 / 降权时：

```json
{ "exclude": ["static/"], "deprioritize": ["scripts/"] }
```

- `exclude`：不进索引；`deprioritize`：仍在索引但排名降低（避免通用名工具抢排产品代码）；
  `include`：反向拉回被 `.gitignore` 的源码；`extensions`：自定义扩展名映射语言。

## 5. billy 特定用法

- **验证分层依赖方向**（`billy-dev-foundation` 分层规则：shared 不依赖业务包、kits 不 import
  `apps/*`）：用 `codegraph callers <某类>` 或 `impact <某类>` 查反向依赖，快速发现越层 import。
- **NestJS 调用链（实测注意）**：`callers`（反向依赖）与 `impact`（影响面）对 NestJS 显式
  `@Inject` 架构**准确**，可用它们验证分层方向；但 `callees`（正向方法调用边）对 DI 链**不可靠**
  —— `this.xxx.method()` 调用边建不出、`@Post` 等装饰器还会误判成别的方法（实测 `callees
  TodoController` 只返回 http-client 的 `post`）。追 controller → service → repository 正向链时，
  用 `callers`（反向定位）＋ `read` 直接读，别用 `callees`。
- **改动评估**：改公开导出 / 基础设施前用 `impact` 看影响面，配合 `affected` 定位受影响测试
  （如 `git diff --name-only | codegraph affected --stdin --quiet | xargs pnpm vitest run`）。
