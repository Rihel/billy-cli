# 会话工作目录：一个会话一个默认目录

> 状态：**设计稿（2026-11-23）**；P0–P4 已实现（2026-11-24），P5 预览另立。
>
> 关联：[workspace.md](workspace.md)（工作区概念与目录）、
> [workspace-preview.md](workspace-preview.md)（预览服务）、
> [ai-file-manager.md](ai-file-manager.md)（文件工具与 `ai_files`）、
> [workspace-file-concurrency.md](../../.agents/memory/workspace-file-concurrency.md)（并发与原子写）。

## 0. 设计摘要

**每个会话在工作区里有一个默认目录 `conversations/<rootConversationId>/`；`bash` 和文件工具默认只在这个目录里工作。技能与平台元数据仍放在工作区根，跨会话共享；需要协作时用显式的 `shared/`。**

| 维度 | 结论 |
| --- | --- |
| 默认目录 | `<workspace>/conversations/<rootConversationId>/` |
| 项目 | 新建和 clone 都放 `conversations/<id>/projects/<name>/` |
| 子会话 | 沿用根会话目录，不另建；结论写 `conversations/<rootId>/subagents/` |
| 共享内容 | `.agents/`（技能）、`.billy/`（平台元数据）在工作区根 |
| 显式共享 | `<workspace>/shared/`（可选；协作同一个项目时用） |
| 老会话 | `conversations.workdir = null` → 回落到工作区根，**不搬文件** |
| 预览 | 每个会话的预览根是它自己的目录（默认 `conversations/<id>/public/`） |
| 成本 | 粗估 1–1.5 周（数据结构 + 工具路径 + 提示词 + UI + 测试） |

## 1. 产品视角

### 1.1 问题

一个工作区可以被多个会话共用。现在所有工具都直接落在工作区根：

- 两个会话都写 `public/index.html`，后写的覆盖先写的；
- 两个会话都写 `README.md` / `package.json`，互相踩；
- 右栏文件树、工作区页文件弹窗、预览根都是同一个根，用户分不清“这是哪个会话的东西”；
- 预览如果只按工作区起一个 `serve`，多个会话的内容会混在一个 URL 里。

工作区的 `fs` 锁只保证“同一路径不写半截”，**不保证两个会话不互相覆盖**；所以需要按会话分目录。

### 1.2 用户与场景

| 角色 | 场景 | 期望 |
| --- | --- | --- |
| AI 会话 | 在一个工作区里做一个站点 / 一次分析 / 一段脚本 | 默认在自己的目录里读写，不碰别的会话 |
| 多个会话 | 同一个工作区里并行做不同任务 | 各自目录、各自预览根、互不覆盖 |
| 多个会话协作 | 同一个项目，两个会话一起改 | 显式用 `shared/` 或工作区根，接受共享 |
| 管理员 | 在工作区页看文件 / 开预览 | 能看到每个会话的目录，知道文件归属 |

**什么叫“协作”**

两个会话需要**读写同一份文件 / 同一个项目**，并且要看到对方的改动，才算协作。只是共用一个工作区、共用技能与凭据，不算协作。

| 场景 | 是否协作 | 放哪 |
| --- | --- | --- |
| A 写后端、B 写前端，共用 `package.json` / 接口定义 | 是 | `shared/` |
| A 写初稿、B 在同一份文档上改 | 是 | `shared/` |
| A 跑测试、B 修同一个仓库的 bug | 是 | `shared/` |
| A 写周报、B 做落地页，互不引用 | 否 | 各自的 `conversations/<id>/` |
| A 分析数据、B 画图，各自产出 | 否 | 各自的 `conversations/<id>/` |
| 拿不准 | 先按不协作 | 放各自目录；需要时再复制到 `shared/` |

规则：

- **默认独立**：没有明确的“同一个项目 / 同一份文件 / 要读另一个会话的产出”信号，就写自己的会话目录。
- **共享要显式**：只有用户明确说“同一个项目”或 AI 确实需要读另一个会话的产物时，才用 `shared/`；`shared/` 不自动创建。
- **工作区根是旧 / 共享项目**：老会话的文件还在根；新会话默认不往根写。
- **v1 只保留约定**：`shared/` 不做专门 UI、不做“共享项目”管理；真有协作场景再补。
- **预览分开**：独立会话各自预览；`shared/` 的预览是工作区级入口，单独标记“会互相覆盖”。

### 1.3 目标与非目标

**目标**

1. 每个会话一个默认目录，`bash` / 文件工具的默认 cwd 与相对路径都以它为准；
2. 技能与平台元数据仍在工作区根，跨会话共享，不复制；
3. 右栏用**工作区文件树**（根是整个工作区）；会话目录在 `conversations/<id>/` 下；工作区页也看整个工作区；
4. 预览按会话起，预览根互不覆盖；
5. 老会话不搬文件、行为不变；
6. 给“多个会话协作同一个项目”留显式的 `shared/` 入口；
7. 子 agent 一律在根会话目录下操作，不另开目录、不单独起预览；
8. 新建和 clone 的项目统一放 `projects/<name>/`，不再分 `project/` 和 `repos/`。

**非目标**

- 不做**硬安全隔离**：`bash` 仍可以 `cd ..`，文件工具也允许 `..` 到工作区根；会话目录是组织与防污染，不是权限边界；
- 不把老会话的文件搬到新目录（另立迁移）；
- 不做“一个会话多个工作区”；
- 不做跨工作区的共享；
- 不改 `ai_files` 的 OSS 归属与 `fileKey` 语义。

### 1.4 交互

**会话页右栏文件树**

- 根是整个工作区；复用现有「工作区」文件树，不另造会话树；
- 会话目录在 `conversations/<rootConversationId>/` 下，`shared/` 也在根；
- 新会话首次打开时 `conversations/<id>/` 为空，展开即可看到；工作区根的其他文件照常显示。

**工作区页文件弹窗**

- 根仍是整个工作区；
- `conversations/<id>/` 按会话分组展示（带会话标题），`shared/` 单独标出；
- 管理员能看全量，不受会话目录限制。

**预览面板（后续）**

- 按会话列出：会话标题、状态、URL、开启 / 关闭；
- 每个会话的预览根默认是 `conversations/<id>/public/`；
- 多个会话可以同时开，各自端口。

**提示词**

- 系统提示里注入 `conversationRoot`（例如 `/workspace/conversations/<id>`）；
- 文件工具的相对路径按 `conversationRoot` 解析；
- 技能正文用 `../../.agents/<技能>/SKILL.md` 读；
- 协作项目显式用 `../../shared/`。

### 1.5 验收用例

| # | 场景 | 期望 |
| --- | --- | --- |
| E1 | 新会话执行 `pwd` | 输出 `conversations/<rootConversationId>`（或容器内等价路径） |
| E2 | 两个会话各写 `public/index.html` | 两个文件在不同目录，互不覆盖 |
| E3 | `read-file` / `write-file` / `file-search` / `workspace-files` | 默认都在会话目录内 |
| E4 | 读技能 `.agents/x/SKILL.md` | 用 `../../.agents/x/SKILL.md` 能读到 |
| E5 | 入站附件 / `file-download` | 物化到会话目录的 `uploads/` / `tmp/` |
| E6 | 老会话（`workdir=null`） | 行为和现在一致，仍以工作区根为根 |
| E7 | 子会话 | 沿用根会话的目录，不另开 |
| E8 | 右栏文件树 / 工作区页文件弹窗 | 都看整个工作区；会话目录在 `conversations/<id>/` 下 |
| E9 | 路径 `..` 越出工作区根 | 拒绝（沿用现有包含性校验） |
| E10 | 会话删除 / 工作区销毁 | 根会话目录删除；子会话不删根目录；工作区销毁全清 |

## 2. 技术视角

### 2.1 目录布局

host（默认托管目录）：

```text
~/.billy/workspaces/<workspaceId>/
├── .agents/                              # 技能正文（共享，只读）
│   └── <skillKey>/                       # 一个技能一个目录
│       ├── SKILL.md
│       ├── .billy-skill                  # 归属标记
│       ├── references/                   # 可选
│       ├── scripts/                      # 可选
│       └── assets/                       # 可选
├── .billy/                               # 平台元数据
│   ├── setup.json
│   ├── setup/
│   │   └── <setupId>@<hash>.done         # 初始化幂等标记
│   ├── credentials.json                  # 可写 HOME 时才有
│   └── preview/                          # host 预览状态与日志
│       ├── <rootConversationId>.json
│       └── <rootConversationId>.log
├── conversations/                        # 每个根会话一个目录
│   └── <rootConversationId>/
│       ├── public/                       # 静态预览根（用户 / AI 内容）
│       ├── projects/                     # 新建 / clone 的项目（约定）
│       │   └── <name>/
│       ├── artifacts/                    # 交付产物（约定；提交 OSS 前放这里）
│       ├── tmp/                          # 临时文件 / 下载（可清理，不作交付）
│       │   └── html/<slug>/              # html-page 构建：src/ dist/ scripts/
│       ├── uploads/                      # 入站附件副本（平台）
│       └── subagents/                    # 子 agent 结论（平台）
│           └── <name>-<subRunId>.md
└── shared/                               # 可选：协作项目（用户内容，不预设子目录）
```

container（`/workspace`）同构，但 `.billy/` 下没有 `preview/`（状态走 `docker inspect`，日志在 `/tmp/billy-preview-<rootConversationId>.log`）：

```text
/workspace/
├── .agents/
│   └── <skillKey>/
│       ├── SKILL.md
│       ├── .billy-skill
│       ├── references/
│       ├── scripts/
│       └── assets/
├── .billy/
│   ├── setup.json
│   ├── setup/
│   │   └── <setupId>@<hash>.done
│   └── credentials.json
├── conversations/
│   └── <rootConversationId>/
│       ├── public/
│       ├── projects/
│       │   └── <name>/
│       ├── artifacts/
│       ├── tmp/
│       │   └── html/<slug>/
│       ├── uploads/
│       └── subagents/
│           └── <name>-<subRunId>.md
└── shared/
```

**工作区与会话目录的子目录（完整）**

| 路径 | 谁写 | 用途 / 生命周期 |
| --- | --- | --- |
| `.agents/<skillKey>/` | 平台 | `SKILL.md`、`.billy-skill`；`references/`、`scripts/`、`assets/` 可选 |
| `.billy/setup/` | 平台 | `<setupId>@<hash>.done` 幂等标记 |
| `.billy/preview/` | 平台（host） | `<rootConversationId>.json` / `.log`；容器没有，状态走 `docker inspect`，日志在 `/tmp` |
| `conversations/<rootConversationId>/public/` | 用户 / AI | 静态预览根；内部由站点自己决定，平台不预设 |
| `conversations/<rootConversationId>/projects/` | 用户 / AI | 新建和 clone 的项目；一个项目一个 `<name>/`；含 `.git`，可能很大 |
| `conversations/<rootConversationId>/artifacts/` | 用户 / AI | 交付产物；长期保留要先 `file-submit` 到 OSS |
| `conversations/<rootConversationId>/tmp/` | 用户 / AI | 临时文件 / 下载；可随时清理，不作交付 |
| `conversations/<rootConversationId>/tmp/html/<slug>/` | `html-page` | 页面构建：`src/` / `dist/` / `scripts/`；提交 `dist/index.html` |
| `conversations/<rootConversationId>/uploads/` | 平台 | 入站附件副本，平铺 `<basename>` |
| `conversations/<rootConversationId>/subagents/` | 平台 | `<name>-<subRunId>.md`，平铺 |
| `conversations/<rootConversationId>/files/` | 旧会话 | 老下载缓存；新会话改用 `tmp/`，不迁移 |
| `shared/` | 用户 / AI | 协作项目；内部由项目自己决定，平台不预设 |

约定：

- `conversations/<rootConversationId>/` 的 id 是**根会话** id；子会话沿用，不另建。
- 新项目和 clone 都放 `projects/<name>/`；下载和临时文件放 `tmp/`；`html-page` 的构建放 `tmp/html/<slug>/`；静态预览产物放 `public/`；交付放 `artifacts/`。平台不预设这些目录内部结构。
- `tmp/` 可随时清理；下载可重下；`projects/` 可能很大，会话删除时一起清；`artifacts/` 要 `file-submit` 到 OSS 才长期保留。
- `.agents` / `.billy` 只在工作区根；不复制进会话目录。
- `shared/` 是可选目录；没有就不建，不占用。
- 老工作区根下已有的项目文件保留原位；这是 legacy，不属于新会话目录。
- `<skillKey>` / `<rootConversationId>` / `<setupId>` / `<name>` / `<fileKey>` 是运行时生成的名称，不是省略。

### 2.2 数据结构

`conversations` 增加一列：

```sql
-- conversations
workdir varchar(255) NULL   -- 相对工作区根；NULL = 回落到工作区根（老会话）
```

- 新根会话创建时写 `conversations/<id>`；
- 子会话写 `NULL`，解析时沿根会话取；
- 老会话保持 `NULL`，不迁移、不搬文件；
- `workdir` 只允许相对路径，校验 `conversations/<id>` 形状；禁止 `..`、绝对路径、空段。

解析顺序：

```
根会话 workdir
  → 非空：用它
  → 空：工作区根（老会话）
子会话
  → 取根会话的 workdir（根为空则工作区根）
```

### 2.3 工具语义

| 工具 | 默认基准 | 说明 |
| --- | --- | --- |
| `bash` | 会话目录 | 不带 `cwd` 时 cwd = 会话目录；`cwd` 入参相对会话目录 |
| `read-file` / `write-file` / `append-file` / `replace-file` | 会话目录 | 相对路径按会话目录解析 |
| `file-search` | 会话目录 | 默认从会话目录搜 |
| `workspace-files` | 会话目录 | 列该会话的文件；`pathPrefix: '../..'` 可看根 |
| `file-submit` | 会话目录 | `filePath` 相对会话目录；`fileKey` 仍是会话内逻辑路径 |
| `file-download` | 会话目录 | 默认放会话目录 `tmp/`；入站放 `uploads/`；老会话 `files/` 保留为 legacy |
| 子 agent 结论 | 根会话目录 | 写 `conversations/<rootId>/subagents/<name>-<subRunId>.md`，不另开目录 |
| `file-list` | 不变 | 列的是 `ai_files`（OSS），不是工作区 |
| `workspace-content`（timeline / AI 图片） | 会话目录 | 路径按会话目录解析 |
| `workspace-link` / 右栏文本预览 | 工作区根 | 右栏工作区树用；路径按工作区根解析 |
| 右栏文件树 | 工作区根 | 复用 `/agent/file/workspace`，不按会话裁剪 |
| 工作区页文件弹窗 | 工作区根 | 仍看全量，含 `conversations/` 与 `shared/` |

边界：

- 相对路径解析后，最终仍要落在**工作区根**之内；`..` 可以回到根，但不能越出根。
- 绝对路径：仍按工作区根解释；模型一般不用。
- `file-submit` 的 `fileKey` 不随目录变：它仍是会话内逻辑路径（如 `reports/a.md`），和 OSS 归属一致。
- `uploads/` 与下载目录从工作区根挪到会话目录；新会话下载直接放 `tmp/`，老会话的 `files/` 不迁移；`ai_files.path` 仍是 `uploads/<basename>` / 调用的 `fileKey`，不改数据。
- **本地回落**（没有 `workspaceId`，`conversationWorkspace` 已经是 `{localRoot}/{conversationId}`）：`workdir` 视为根，不再套 `conversations/`，避免出现 `{localRoot}/{会话}/conversations/{会话}`。
- **接口路径口径**：右栏工作区树 / `preview`（source=workspace）/ `workspace-link` 返回并解析**相对工作区根**的路径；`workspace-content`（timeline / AI 图片）仍按会话目录解析；工作区页文件接口也按工作区根。

### 2.4 路径解析实现

当前 `FileContext` 只有 `conversationId` / `workspaceId`；`resolveWorkspacePath` 以工作区根为基准。改造：

1. **`FileContext` 增加 `workdir?: string`**（相对工作区根；为空 = 根）。
2. **`resolveWorkspacePath` 增加 `base?: string`**：
   - 相对路径 = `resolve(workspaceRoot, base, path)`；
   - 包含性校验仍以 `workspaceRoot` 为界；
   - 远程执行面返回的目标路径经 `relPath(workspaceRoot, target)` 得到 `conversations/<id>/<相对路径>`，再交给 `fsPort`。
3. **`WorkspaceLocator` 返回 `{ workspaceId, workdir }`**：
   - 查询 `conversations` 的 `workspace_id` / `root_conversation_id` / `workdir`；
   - 子会话回落到根会话的 `workdir`；
   - 缓存 30s，命中结果才缓存。
4. **`bash` 执行器**：
   - 无 `cwd` 时传 `cwd = workdir`；
   - 有 `cwd` 时传 `workdir/cwd`；
   - 首次使用前确保 `conversations/<id>` 存在（见 §2.5）。
5. **文件工具**：
   - `FileService` 的 `resolveOf` 传入 `base = ctx.workdir`；
   - `workspaceFiles` / `search` 的起点改成会话目录；
   - `submit` / `download` / `preview` / `workspaceContent` / `workspaceLink` 同上；
   - `readdir` / `listTree` 的远程路径加 `conversations/<id>` 前缀。
6. **主侧 / 公共侧**：
   - `main` 的 `workspace-content`（timeline / AI 图片）带会话 `workdir`；右栏工作区树 / 预览 / 链接用 `workspaceRoot` 上下文（不带 workdir）；
   - `common-capability` 的 `file-submit` / `file-download` 同样从请求的 `workspaceConversationId` 解析 `workdir`；
   - 解析失败按工作区根回落（老会话）。

### 2.5 会话目录创建与清理

- **创建**：首次 `bash` / 文件调用时确保 `conversations/<rootConversationId>` 存在；可在 workspace-service 加一个 `mkdir` 原语，或由 `bash` 先 `mkdir -p`。只建根会话目录，子会话不建。
- **新会话**：`conversation.service.create` 写 `workdir = conversations/<id>`；目录可以懒创建，不必在创建会话时阻塞。
- **子目录按需创建**：`public/`、`projects/`、`artifacts/`、`tmp/`、`uploads/`、`subagents/` 由首次使用创建；不预先铺空目录。
- **清理**：
  - 删除根会话 → 停该会话预览 → 删 `conversations/<id>`（连同 `tmp/`、`projects/`、`artifacts/`、`public/`、`uploads/`、`subagents/`）；子会话删除不删根目录；
  - 删除工作区 → 整个工作区目录按现有 `purge` 清理；
  - 老会话 `workdir=null`：不建目录，不清理。
- **保留策略**：
  - `tmp/` 可随时清理，不作为交付；
  - `tmp/` 里的下载可重下，不保证长期保留；
  - `projects/` 可能很大，会话删除时清理；
  - `artifacts/` 要 `file-submit` 到 OSS 才长期保留；
  - `public/` 是预览产物，不是交付真身。
- **子会话**：不建自己的目录，`workdir` 为空、解析时沿根会话；结论写根会话目录的 `subagents/`；预览也沿用根会话，不单独起服务。

### 2.6 UI 与提示词

**右栏文件树**

- 复用现有「工作区」文件树，根是整个工作区；`conversations/<id>/` 就是会话目录；
- 会话目录内按 `public/`、`projects/`、`artifacts/`、`tmp/`、`uploads/`、`subagents/` 展示；`tmp/` 可折叠；`projects/` 里的 `.git` 不展示；
- 不把根裁到会话目录；不另造一棵会话树；
- 空态：「工作区还没有文件。AI 写文件后出现。」

**工作区页文件弹窗**

- 根不变（整个工作区）；
- `conversations/<id>` 目录按会话标题分组，`shared/` 单独一组；
- 管理员可以看到全部，不受会话目录限制。

**html-page 的落点**

- 单文件 HTML 不是 `projects/` 项目；在 `tmp/html/<slug>/` 下建 `src/`、`dist/`、`scripts/`；
- `file-submit` 提交 `tmp/html/<slug>/dist/index.html`，`fileKey` 用业务路径（如 `reports/xxx.html`）；
- 要让它出现在工作区预览服务里，才把产物放 `public/`；`dist` 是单文件交付，`public/` 是静态预览，两者不混。

**提示词**

- `environment.eta` 增加：
  - `会话目录：/workspace/conversations/<id>`（或 host 路径）
  - `技能目录：/workspace/.agents`（只读）
  - `共享项目：/workspace/shared`（可选）
  - 子目录约定：`projects/` 新建 / clone 项目、`artifacts/` 交付、`tmp/` 临时 / 下载、`public/` 静态预览、`uploads/` 入站、`subagents/` 子 agent 结论
- `requirements.eta` 的文件操作段更新：
  - 相对路径默认会话目录；
  - 技能用 `../../.agents/<skillKey>/SKILL.md`；
  - 协作项目用 `../../shared/`；
  - `git clone` 到 `projects/<name>/`；
  - 下载 / `curl -o` / `wget -O` 到 `tmp/`；
  - 中间产物写 `tmp/`，不作为交付；
  - `html-page` 单文件：构建放 `tmp/html/<slug>/`，`file-submit` 提交 `dist/index.html`；`public/` 只用于预览 URL；
  - 交付物写 `artifacts/`，再 `file-submit` 到 OSS；
  - 静态预览写 `public/`（如果启用预览）；
  - 入站附件读 `uploads/`；
  - 没有明确协作信号时，不往工作区根或别的会话目录写。

### 2.7 安全与并发

- **不是安全边界**：会话目录只解决“互相覆盖 / 找得到自己的文件”。`bash` 仍可 `cd ..`，文件工具也允许 `..` 到工作区根；真正的隔离是容器 / 沙箱。
- **并发**：会话目录天然按会话分开；同一路径的写仍走现有 `fs` 锁与原子写；共享 `shared/` 的冲突靠锁 + 约定，不保证业务语义。
- **越界**：相对路径解析后必须落在工作区根内；软链 / `realpath` 校验沿用 `resolveWorkspacePath`。
- **`.billy` / `.agents`**：仍在根；模型可以读技能，不鼓励写 `.billy`；写入保护留给后续。
- **预览**：每个会话的预览根独立，避免 `public/` 污染；共享项目预览另设工作区级入口。

### 2.8 失败模式

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `pwd` 不是会话目录 | `workdir` 没解析 / 老会话 null | 检查根会话 workdir；老会话回落根是预期 |
| 会话目录不存在 | 懒创建失败 / 权限 | 首次调用前 `mkdir`；失败返回明确错误 |
| 技能读不到 | 仍用 `.agents/<skillKey>/SKILL.md` 相对会话目录 | 提示词改成 `../../.agents/<skillKey>/SKILL.md` |
| 右栏空 | 工作区没有文件 / 查询错 | 检查 `workspaceRoot` 上下文与工作区状态 |
| 入站附件找不到 | 仍物化在根 `uploads/` | 改到会话目录 `uploads/` |
| `file-submit` 找不到文件 | `filePath` 仍按根解析 | 按会话目录解析 |
| 下载文件找不到 | 新会话仍写 `files/` | 新会话写 `tmp/`；老会话 `files/` 保留 |
| clone 到会话根 | 提示词没给 `projects/` | 提示词要求 `projects/<name>/` |
| `tmp/` 被当成交付 | 中间产物没转 `artifacts/` | 交付写 `artifacts/` 并 `file-submit` |
| 预览根错 | 仍用工作区根 `public/` | 改成会话目录 `public/` |
| 老会话行为变了 | 误给老会话写了 `workdir` | 老会话保持 `null` |
| 删除会话误删共享 | 子会话清理了根目录 | 只清理根会话的目录 |

### 2.9 测试

- 单测：`workdir` 解析（新 / 老 / 子会话）；`resolveWorkspacePath` 的 base 与越界；`workspaceFiles` / `search` 起点；`file-submit` / `download` 路径；目录名校验。
- 集成：workspace-service 的 `FileExecutor` / `BashExecutor` 带 workdir；main / common 的 `FileContext`；假 fsPort 断言远程路径带 `conversations/<id>`。
- e2e：两个会话各写 `public/index.html` 不互相覆盖；`bash pwd`；技能 `../../.agents`；入站附件；老会话回落；子会话沿用。
- 手工：右栏文件树、工作区页文件弹窗、预览面板；按 `workflow.md` 不跑无头浏览器，界面交用户验。

### 2.10 上线与回滚

- 迁移：`conversations.workdir` 新增列，默认 `NULL`；不搬文件。
- 新会话写 `conversations/<id>`；老会话 `NULL` 回落；开关 `WORKSPACE_CONVERSATION_WORKDIR_ENABLED`（默认开；关掉后新会话不写，回到工作区根行为）。
- 回滚：关闭开关；新会话不再写 `workdir`；已写的会话继续用；老会话不受影响。
- 文档：落地后更新 [workspace.md](workspace.md) §3.1.2 的目录树，以及 [workspace-preview.md](workspace-preview.md) 的目录约定（预览根改为会话目录）。

### 2.11 关键决策

| # | 决策 | 结论 | 原因 |
| --- | --- | --- | --- |
| D1 | 目录形态 | `conversations/<rootConversationId>/` | 按会话分开；id 是根会话，子会话沿用 |
| D2 | 老会话 | `workdir=null` 回落工作区根 | 不搬文件、行为不变、可回滚 |
| D3 | 子会话 | 沿用根会话目录 | 子 agent 是同一任务的一部分，不该另开 |
| D4 | 技能 / 凭据 | 仍在工作区根 | 共享、只读、避免复制 |
| D5 | 共享项目 | 可选 `shared/` | 协作显式选择；默认不共享 |
| D6 | 入站 / 下载 | 会话目录 `uploads/` / `tmp/`；老会话 `files/` legacy | 与文件工具默认目录一致 |
| D7 | 隔离强度 | 约定，不是安全边界 | `bash` 仍可 `..`；真正隔离靠容器 / 沙箱 |
| D8 | 预览 | 会话目录为根，每会话独立 | 避免 `public/` 污染 |
| D9 | 开关 | 部署开关 + 新会话写 workdir | 可灰度、可回滚 |
| D10 | 项目落点 | 新建 / clone 都放 `projects/<name>/` | 一个根，少一层概念；`repos/` 不再单列 |

### 2.12 后续待定

1. `shared/` 与工作区根的关系：共享项目放 `shared/`，还是直接放根。
2. 老会话的迁移策略：把根文件搬进 `conversations/<id>` / `shared/`，还是永久回落。
3. 文件写入是否要限制在会话目录 + `shared/`（比 `..` 更严），还是只做约定。
4. 右栏是否需要在工作区树里提供「跳到当前会话目录」的快捷入口（树仍是工作区根）。
5. 会话删除时目录保留还是删除（v1 建议删除根会话目录）。
6. 预览端口段大小 / 多会话同时预览的上限。
7. Windows host 的 `mkdir` / 路径大小写 / 进程组验证。
8. 一个会话允许几个项目？`projects/<name>/` 的命名、重名与清理策略。
9. `tmp/` / `projects/` 的配额与清理触发：按会话、按工作区，还是按时间。
10. `artifacts/` 与 `public/` 的交付口径：哪些自动提交 OSS，哪些只留在会话目录。
11. `tmp/` 在会话开始 / 结束 / 工作区回收时的清理粒度。

### 2.13 实施计划

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| P0 | `conversations.workdir` 迁移 + 模型 + `WorkspaceLocator` 返回 workdir + 开关 | 2 天 |
| P1 | `FileContext` / `resolveWorkspacePath` / `FileService` 全部路径 + `bash` 默认 cwd + 目录创建 | 3–4 天 |
| P2 | main / common 的 `FileContext` 注入 + 入站 / `tmp/` 路径 | 2 天 |
| P3 | 提示词（`tmp/` / `projects/` / `artifacts/`）+ 右栏文件树 + 工作区页文件弹窗 | 2 天 |
| P4 | 测试 + 文档 + 灰度 | 2 天 |
| P5 | 预览按会话根（与 [workspace-preview.md](workspace-preview.md) 一起） | 另算 |

合计约 **1–1.5 周**（不含预览服务本身）。

## 3. 附：与预览的关系

- 预览的每个会话 root = `conversations/<id>/public/`（或面板里指定的项目目录）；
- 静态站默认服务 `public/`；应用项目的 `command` cwd 用 `projects/<name>/`，root 可按面板覆盖；
- 多会话各自端口 / URL；工作区页「预览」面板按会话列出；
- 子 agent 沿用根会话的预览，不单独起服务；
- 共享项目（`shared/`）的预览是工作区级入口，单独标记“会互相覆盖”；
- 本规范落地后，[workspace-preview.md](workspace-preview.md) 的目录约定以本文为准。
