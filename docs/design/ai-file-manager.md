# AI 文件管理：会话级文件树 + 对象存储

> 状态：已实施（2026-11-11，后端 + 前端 + 提示词）。
> 关联：`ai-agent.md` §3.15（workspace / bash）、§3.16（附件）、`ai-agent-tool-engine.md`（工具组 DSL）、
> `storage-access-policy.md`（key 命名空间）。

## 0. 一句话

AI 在工作区生成文件 → `file-submit` 上传到对象存储 → `ai_files` 记一行 →
会话详情返回文件树 → 前端在线预览 / 下载；`file-download` 把对象下载回**本会话工作区**，`read-file` 分页读内容。
用户上传的附件也在同一张表里（`source='user'`），和 AI 产出的文件共用一棵树、一套预览 / 下载。

## 1. 现状与问题

### 1.1 现在 AI 产出的文件去哪了

| 位置 | 现状 | 问题 |
| --- | --- | --- |
| `bash` 的 workspace | 本地磁盘，所有会话共用一个根（`AGENT_COMMAND_WORK_DIR`） | 用户拿不到；换 Pod / 重启就丢；会话之间会串文件 |
| 对象存储 | 只服务**入站附件**（用户上传）与头像 | 没有服务端写入通道，AI 产出的文件进不去 |
| `timelines` | 工具入参出参全量入库 | 二进制不能进 payload（会把审计表撑变形） |
| 前端 | 只能看消息里的附件 | 没有"本会话有哪些文件"的入口 |

### 1.2 要解决的三件事

1. **AI 能提交文件**：把工作区里的某个文件上传到对象存储，登记到本会话；
2. **AI 能读回文件**：跨轮 / 压缩后 / 另一个 agent 需要继续加工时，按会话内路径下载回工作区；
3. **用户能看、能下**：右侧「文件」tab 分「会话文件（OSS）」与「工作区」两个视图；
   会话文件可预览 / 下载，工作区可浏览 / 预览（图片 / PDF / 文本等，按 §8.4 矩阵）。
4. **大文件不能一次读完**：`read-file` 按行分页（`offset` / `limit`），`file-search` 先定位；
   附件链路只内联前 20k 字符并明示截断，全文在对象存储 / workspace。

### 1.3 核心矛盾

| 矛盾 | 结论 |
| --- | --- |
| 文件本体 vs 审计表 | **二进制只进对象存储**；`ai_files` 只存元数据；`timelines.payload` 绝不存字节（与附件 §3.16.1.1 同一口径） |
| 文件是"会话的资源" vs 需要查询 / 配额 / 清理 | **独立一张 `ai_files` 表**：按会话 + 路径唯一，能查、能计数、能清理；不用 `conversations.ai_files` JSONB（并发提交会丢更新、跨会话查询要扫表） |
| AI 只知道工作区路径 vs 不能让模型决定 userId / 会话 id | 对象 key 由**工具**拼：`user/{userId}/{conversationId}/{fileKey}`；AI 只传 `fileKey`，`userId` / `conversationId` 从 `ctx.caller` 取 |
| 本地工作区 vs 多副本 | 工作区是**本地临时盘**；文件在对象存储。`read` 在缓存缺失时重新下载，不假设本地文件还在 |

### 1.4 边界：文件管理 ≠ 交付物全集

AI 的"交付物"可能是文件、网页链接、一段文本，也可能是**数据库里的记录**（例如建了一条待办、
改了一个商品）。本模块只负责**文件**，判据是"内容以字节形式存在、需要对象存储"。

- **数据库记录不是文件**：它已经在业务表里，有自己的归属、权限、生命周期与业务页面。AI 通过业务
  工具创建它，工具出参 + 时间线就是"交付证据"；把它塞进 `ai_files` 会凭空多出一个第二事实源，
  还要在没有 `bytes` / `sha256` / `key` 的列上硬编。
- **"交付"一个记录** = 业务工具成功返回 + 最终回答里给出入口（id / 链接）；前端用工具卡渲染记录，
  不进文件树。
- **`ai_files` 的不变量**：每一行都必须有对象存储里的字节。没有这个不变量，预览 / 下载 / 配额 /
  清理全都要分叉。
- 如果产品以后确实需要"本会话所有交付物"的统一视图，再加一层只读索引 `ai_artifacts`
  （`kind` = file / record / url / text，`ref` 指向 `ai_files.id` 或 `{table, id}`）；
  文件仍然以 `ai_files` 为准。**本期不做**。

### 1.5 入站附件也进 `ai_files`（用 `source` 区分）

入站（用户上传）与出站（AI 提交）都进同一张表，文件树统一展示；靠 `source` 区分来源。

| 维度 | 入站 `source='user'` | 出站 `source='ai'` |
| --- | --- | --- |
| key | `user/{userId}/{md5}{ext}`（**内容寻址**） | `user/{userId}/{conversationId}/{fileKey}`（**会话寻址**） |
| path | `uploads/{md5}{ext}` | `{fileKey}` |
| filename | 原始文件名 | `fileKey` 的最后一段 |
| 对象归属 | 用户级；同一份文件跨会话共享同一个对象 | 会话级；删会话可安全清理 |
| workspace 副本 | **有**：发送时物化到 `{workspace}/uploads/{md5}{ext}` | **有**：`file-download` 时物化到 `{workspace}/files/{path}` |
| 删除会话 | **只软删行，不删对象**（可能被其他会话引用；引用计数清理后续再做）；workspace 副本随目录删 | 软删行 + 删对象；workspace 缓存随目录删 |
| 配额 | 计入会话 100MB / 200 个（同一对象跨会话各算一次，这是会话视角） | 计入 |

口径：

- **对象存储不重复写**：入站 key 是前端预签名时已经写好的；服务端不再往对象存储传一遍。
- **workspace 物化一份**：发送消息时把入站对象复制到 `{workspace}/uploads/{md5}{ext}`，
  AI 可以直接用 bash / python 处理。这份是**缓存**：丢了（换 Pod）由 `file-download` / 下次发送重建。
- **物化复用 bytes**：附件服务本来就要 `getObject` 读给模型，顺手写 workspace，避免二次下载；
  没读到的附件（能力不匹配 / 被跳过）由 `file-download` 懒加载。
- **`uploads/` 前缀保留给入站**：`file-submit` 的 `fileKey` 禁止以 `uploads/` 开头，避免和入站混。
- **入站 `sha256` 可空**（key 自带 md5，足以做内容身份）；AI 产出必有 sha256。
- 入站文件在**用户发消息时**登记：`ChatAttachmentSchema` 已有 `key/filename/mediaType/bytes`，
  不需要再读一次对象；同一会话内同一内容重复发送 → 按 `(conversation_id, path)` upsert，不新增行。
- 登记时机：`chat` / `chatStream` 在附件校验（`AttachmentKeyPolicy`）通过后、调用模型前调
  `registerInbound`；失败只记 error，不阻塞这一轮（附件仍会喂给模型，文件树下次刷新补上）。
- **大文件不在附件链路里一次塞**：`ChatAttachmentService` 只内联前 20k 字符并明示截断；
  全文在对象存储 + workspace，后续用 `read-file` 分页 + `file-search` 定位（§6.5 / §6.6）。
- 文件树里用 `source` 打标（「用户上传」/「AI 生成」），`filename` 只用于展示；`path` 是身份。

## 2. 决策记录（已讨论过的取舍）

| 议题 | 结论 | 理由 |
| --- | --- | --- |
| 元数据存哪 | **独立表 `ai_files`**，否决 `conversations.ai_files` JSONB | 同一路径并发提交会丢更新；JSONB 里查 / 计数 / 清理都别扭；表可以做唯一键与索引 |
| key 谁拼 | 工具拼，AI 只传 `fileKey` | 模型不该有能力指定 userId / 会话 id / 完整 key（否则可越权写别人的前缀） |
| key 前缀 | 保留 `user/`：`user/{userId}/{conversationId}/{fileKey}` | 现有 `assertDownloadKey` 只认 `user/{userId}/` 前缀；去掉它要改下载鉴权并让清理扫两套前缀 |
| 工作区 | 每个会话独立：`{workspaceRoot}/{conversationId}` | 会话之间不串文件；`bash` 与文件工具看到同一个目录 |
| `read` 语义 | **下载到工作区**（用户口径），返回本地路径；文本类附带预览 | 继续加工（bash / python）需要真实路径；`list` 负责"只看元数据" |
| 同 `fileKey` 重复提交 | 覆盖（upsert），返回 `replaced` + 旧 sha256 | 文件是"最新版"，不是版本库；时间线保留每次 hash / size，旧字节不保留 |
| 读取范围 | 仅本会话 | 跨会话读取需要用户显式选择，不能让模型猜 |
| 大文件读取 | **分页 + 搜索** | 1w 行文件一次读会顶爆窗口；`read-file` 分页 + `file-search` 定位；不自动摘要 |
| 前端 | 右栏「文件」两个视图（会话文件 / 工作区）+ 工具卡 | 生命周期不同不能混树；工具卡负责"刚提交的这一份" |
| `content` 直传文本 | **本期不做** | 工具参数保持一种形状（`filePath` + `fileKey`）；`bash` 关闭时的文本文件列为后续扩展 |
| 版本管理 | **本期不做** | 覆盖语义已满足"最新文件"；要回滚把版本号拼进 `fileKey` |
| Office 在线预览 | **OOXML 已做** | `.docx` / `.xlsx` / `.xls` / `.pptx` 前端渲染；老 `.doc` / `.ppt` 仍只给下载 |
| 入站附件进 `ai_files` | **做** | `source='user'` 引用已有对象；删会话只软删行、不删共享对象；配额按会话计（§1.5） |

## 3. 数据模型

### 3.1 `ai_files` 表

`apps/server/src/database/entities/ai-file-entity.ts`（新增，登记进 `root.module.ts` 的 `entities`）。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(20) pk | `BaseEntity` 的 nanoid |
| `conversation_id` | varchar(20) | 逻辑引用，**无物理外键**（全工程硬规则） |
| `source` | varchar(8) | `user`（用户上传）/ `ai`（AI 提交）；字典 `FileSource` 是唯一事实源 |
| `path` | varchar(255) | 会话内逻辑路径；入站 `uploads/{md5}{ext}`，AI `{fileKey}`；**同一会话内唯一** |
| `filename` | varchar(255) | 展示名；入站原始文件名，AI 取 `path` 最后一段 |
| `key` | varchar(512) | 对象存储完整 key；入站是附件已有的 key，AI 是服务端拼的会话 key |
| `media_type` | varchar(128) | 服务端按后缀推断，不信模型自述 |
| `bytes` | int | 文件字节数（单文件上限 5MB，int 足够） |
| `sha256` | varchar(64) null | 内容哈希：幂等 / 覆盖判定 / 下载校验；AI 必有，入站可空（key 自带 md5） |
| `user_id` | varchar(20) null | 上传者 / 提交者；管理员 / 无身份为 null |
| `run_id` | varchar(20) null | 入站 = 收到附件的那一轮；AI = 提交的那一轮 |
| `tool_call_id` | varchar(64) null | 仅 AI 有；入站为 null |
| `created_at` / `updated_at` / `deleted_at` | timestamp(3) | `BaseEntity` 自带；`deleted_at` 为软删 |

索引：

```sql
UNIQUE (conversation_id, path)   -- 一个会话内一个路径只有一份文件
INDEX  (conversation_id, updated_at)
INDEX  (conversation_id, source) -- 文件树按来源过滤 / 分组
```

口径：

- **`path` 是业务主键**：`submit` / `registerInbound` 按它 upsert，`read` / `list` 按它查；
  `id` 只给 UI key 与审计引用；
- **`filename` 只用于展示**；`path` 才是身份（入站 `uploads/...`、AI `{fileKey}`）；
- **软删**：AI 行对象异步删除；入站只软删行，**对象保留**（内容寻址，可能被其他会话引用）；
- **唯一键与软删**：重新提交同一个 `path` 时 `upsert` 会把 `deleted_at` 置回 null，不新插一行。
  实现注意：TypeORM 的软删默认过滤会把已删行排除在查询外，upsert 必须走原生 SQL（或 `withDeleted`），
  否则会撞 `UNIQUE (conversation_id, path)`；
- **入站登记**由聊天链路调 `FileService.registerInbound`，不经过工具；同一内容不同文件名时更新 `filename`。

### 3.2 文件树

库里是**扁平行**，树由纯函数 `buildFileTree(entries)` 生成（放 `@repo/shared`，前后端共用、可单测）。

```ts
export interface AgentFileModel {
  /** 会话内逻辑路径；入站 uploads/{md5}{ext}，AI {fileKey} */
  path: string
  /** 来源：user = 用户上传，ai = AI 提交 */
  source: 'user' | 'ai'
  /** 展示名：入站原始文件名，AI 取 path 最后一段 */
  filename: string
  /** 对象存储完整 key（前端预览 / 下载用） */
  key: string
  bytes: number
  mediaType: string
  /** AI 产出必有；入站可空（key 自带 md5） */
  sha256: string | null
  createdAt: string
  updatedAt: string
}

export interface AgentFileNode {
  /** 文件用 filename；目录用 path 段 */
  name: string
  /** 会话内完整逻辑路径，如 reports/2026/q1.pdf */
  path: string
  type: 'dir' | 'file'
  /** 目录才有 */
  children?: AgentFileNode[]
  /** 文件才有 */
  file?: AgentFileModel
}
```

- 目录**隐式生成**：`reports/2026/q1.pdf` 会生成 `reports` → `2026` 两层目录；
  入站文件在 `uploads/` 下，UI 把这一层显示成「用户上传」分组；
- 空目录不落库（没有文件就没有目录）；
- 排序：目录在前、同类按名字升序（前端也好做）；
- 文件行用 `source` 打标（「用户上传」/「AI 生成」），不靠路径猜；
- 上限 200 个文件 / 100MB（入站 + 出站都算；同一对象跨会话各算一次，这是会话视角）；
  树最多 200 个叶子，`conversation/detail` 一次带回可接受；两个上限谁先到就以谁为准。

### 3.3 配额

| 项 | 默认 | 可配 | env 硬上限 |
| --- | --- | --- | --- |
| 单文件 | 5MB | `maxBytes` | `AGENT_FILE_MAX_BYTES` |
| 单会话文件数 | 200 | `maxFilesPerConversation` | `AGENT_FILE_MAX_FILES` |
| 单会话总字节 | 100MB | `maxTotalBytesPerConversation` | `AGENT_FILE_MAX_TOTAL_BYTES` |
| 单次读取 | 5MB | `readMaxBytes` | `AGENT_FILE_READ_MAX_BYTES` |

超限**拒绝并说明**（"本会话文件已达上限 200 个 / 100MB"），不静默丢弃。
配额是**会话视角**：入站 + 出站都算；同一入站对象跨会话各算一次（不是存储成本的重复计算）。

## 4. 对象 key 与命名空间

### 4.1 key 公式

```
出站（AI 提交）：user/{userId}/{conversationId}/{fileKey}
出站（管理员）： admin/{conversationId}/{fileKey}
出站（无身份）： system/{conversationId}/{fileKey}
入站（用户上传）：user/{userId}/{md5}{ext}   # 附件链路的既有 key，不是工具拼的
```

- `fileKey` 是**会话内逻辑路径**（`reports/2026/q1.pdf`），不是完整 key；
- `userId` / `conversationId` 从 `ctx.caller`（运行时信封）取，**模型不传**；
- 入站 key 由前端预签名上传时服务端 `resolveUploadKey` 改写（`user/{userId}/` + 原始 md5 名），
  `ai_files` 只**引用**它，不再拼一次；
- `user/` 前缀与 `storage-key.ts` 的 `assertDownloadKey` 对齐：前台用户下载自己的文件直接通过，越界 403。

### 4.2 `fileKey` 清洗

模型可以自由填 `fileKey`，不能直接拼 key：

- 逐段校验：每段只允许 `\p{L}\p{N}._-`（允许中文）；出现其它字符（`\`、空格、控制字符等）
  **直接拒绝，不做静默替换** —— 否则两个不同的名字会被清洗成同一个 key；
- 禁空段、`.`、`..`、首尾点、首尾空格；
- 最多 8 层，总长 ≤255，完整 key ≤512；
- 归一化后为空 → `invalid-input`；
- 例：`reports/2026/q1.pdf` ✅；`../etc/passwd` ❌；`reports//q1.pdf` ❌；`/abs.pdf` ❌。

### 4.3 下载鉴权

- 前台用户：`assertDownloadKey` 要求 `user/{userId}/` 前缀，文件天然满足；
- 管理员：`userId` 为空，按现状放行；
- **不需要改 `storage-key.ts`**（这是保留 `user/` 前缀的直接收益）。

## 5. 工作区（workspace）

### 5.1 布局

```
AGENT_COMMAND_WORK_DIR=~/.billy/workspaces        # 所有会话的根（历史名，语义是 AI workspace 根）
~/.billy/workspaces/
  {conversationId}/
    notes.md                                      # AI 用 bash 直接生成的文件
    uploads/                                      # 入站附件副本（发送时物化，可重建）
      9f2c….pdf
    files/                                        # AI 文件的 file-download 下载缓存（可随时删）
      reports/2026/q1.pdf
```

- 根目录 = `AgentConfig.commandWorkDir`（env `AGENT_COMMAND_WORK_DIR`；未配置时默认 `~/.billy/workspaces`，
  **不再回落 `process.cwd()`**，否则会话目录会建进仓库）；
- 会话目录 = `{root}/{conversationId}`；`bash` 的 `cwd` 与文件的 `filePath` 都以它为根；
- `file-download` 的默认落点：`source='user'` → `{workspace}/{path}`（即 `uploads/...`，通常已有物化副本）；
  `source='ai'` → `{workspace}/files/{path}`，避免和 AI 自己生成的文件撞名。

**行为变化**：未配置根时从 `process.cwd()` 改为 `~/.billy/workspaces`（否则会话目录会建进仓库）。
已有部署继续用 `AGENT_COMMAND_WORK_DIR`，不受影响；旧根下的文件不会自动搬进会话目录。

### 5.2 与 `bash` 的整合（必须一起改）

现状：`BashTool` 用**全局根**做 `cwd`，`checkWorkDir` 也按全局根判。

改成：

- `execute`：`root = resolve(base, caller.conversationId)`；`mkdir -p`；`target = resolve(root, input.cwd ?? '.')`；
- `checkWorkDir`：同样按**会话根**判越界，而不是全局根 —— 否则模型传 `cwd: '..'` 就能跨会话；
- `onApplicationBootstrap`：只建根目录，会话目录按需建；
- `BashConfig.workDir` **退役**：根只能有一个来源（env）。后台工具页不再展示该字段；
  旧库里的值会被 zod 丢掉，不迁移；
- 测试会红：`bash.test.ts` 现在断言 `result.cwd === tmpdir()`，改成 `tmpdir()/conv-test`。

### 5.3 路径安全

统一纯函数 `resolveInsideWorkspace(root, target)`：

1. `resolve(root)` 与 `resolve(target)`；
2. `relative(root, target)` 判是否在根内（天然处理 `..` 与 Windows 大小写差异）；
3. **再 `realpath` 一次**判包含 —— `path.relative` 挡不住软链（工作区里一个指向 `/etc/passwd` 的软链）。

- `submit`：对**源文件** `realpath`，且 `stat.isFile()`、`size > 0`；
- `read`：先找到目标**最近的已存在祖先**并 `realpath` 判包含，再 `mkdir -p`；目标已存在时对目标
  `realpath`（防软链覆盖），写临时文件后 `rename`（原子）。

### 5.4 如实记录：这是布局隔离，不是沙箱

按会话分目录只保证"默认工作目录"不串；`bash` 的命令参数仍能 `cd ..`、用绝对路径、
或在脚本里读别的会话目录（[`ai-agent.md` §3.15](ai-agent.md) 已写明"只约束 cwd，不约束命令读什么"）。
真正的隔离只能靠容器 / 低权限用户 / 只读挂载，不在本期范围。

### 5.5 清理

- **删除会话必须清理工作区**：`AgentConversationService.remove` 在 `softDelete` 成功后调用
  `FileService.cleanupConversation(conversationId)`，用 `fs.rm({ recursive: true, force: true })`
  删 `{root}/{conversationId}`；删之前先过 §5.3 的包含判断（`conversationId` 也要按白名单校验）；
  删不掉只记 error，靠 TTL 兜底，不阻塞会话删除；
- 同一次清理顺带软删 `ai_files` 行；对象**只删 `source='ai'`**，入站对象保留（见 §10.2）；
- 定时清理：超过 N 天未活动的会话目录（默认 7 天，env 可调）；
- `bash` 每次执行前 `mkdir -p`，目录被删也能继续；
- 多副本：删除请求只清**当前 Pod** 的本地目录；其他 Pod 的副本靠 TTL；`read` 缓存未命中会重新下载。

## 6. 工具组

### 6.1 工具面

九个工具，分两组：**对象存储三件套** + **workspace 六件套**。

| 工具 key | 方法 | 作用 | 方向 |
| --- | --- | --- | --- |
| `file-submit` | `submit` | 把 workspace 文件上传到 OSS，登记 `ai_files`（`source='ai'`） | workspace → OSS |
| `file-download` | `download` | 把本会话的 OSS 文件下载到 workspace，返回本地路径 | OSS → workspace |
| `file-list` | `list` | 本会话文件清单（用户上传 + AI 生成） | `ai_files` |
| `workspace-files` | `list` | 工作区文件清单（**扁平列表**，不是树） | workspace |
| `read-file` | `read` | 分页读 workspace 文本文件 | workspace |
| `file-search` | `search` | 在整个 workspace 的文本文件里搜多个关键词（空格分隔），返回文件路径 + 行号 + 行内容 | workspace |
| `write-file` | `write` | 整文件写入 / 覆盖 | workspace |
| `replace-file` | `replace` | 精确字符串替换（`oldText` → `newText`） | workspace |
| `append-file` | `append` | 追加到文件末尾（不存在则创建） | workspace |

组级：

```ts
@Injectable()
@ToolGroup({ category: 'core', scope: 'all' })
export class FileTools { … }
```

- `scope: 'all'`：用户与管理员会话都能用；
- 子 agent 也可以使用这组工具（工作区是共享的；父 agent 负责给不同子助手分配不同文件，工具不提供跨 run 文件锁）；
- `file-submit` / `file-download` / `file-list` 只碰本会话的 `ai_files`；
- `workspace-files` 只列 workspace 文件，不查 `ai_files`；
- `read-file` / `write-file` / `replace-file` / `append-file` 只碰 **workspace 内**的路径；
- **没有删除工具**：删除走会话删除；workspace 文件可以覆盖，但不提供 remove；
- **`read-file` 只分页**；要在整个工作区里定位内容用 `file-search`（空格分隔多个关键词，返回文件路径 + 行号 + 行内容）。
- **列文件分两个工具**：`file-list` 列会话文件（OSS），`workspace-files` 列工作区文件（扁平列表）。

> 代码归属：`FileService` / `FileRepository` / `FileTools` 放 `modules/ai/files/`（与 `skills/` 同级）。
> `runtime/conversation.service` 直接调 `FileService.cleanupConversation`，避免 `runtime → tools` 的反向依赖。

### 6.2 配置（每个字段必须有默认值）

```ts
const FileConfig = z.object({
  enabled: z.boolean().default(true),
  maxBytes: z.number().int().positive().default(5 * 1024 * 1024),          // 单文件 OSS / workspace 上限
  maxFilesPerConversation: z.number().int().positive().default(200),
  maxTotalBytesPerConversation: z.number().int().positive().default(100 * 1024 * 1024),
  readMaxBytes: z.number().int().positive().default(5 * 1024 * 1024),      // read-file / replace 读取上限
  pageLines: z.number().int().positive().default(200),                     // 分页默认行数
  maxPageChars: z.number().int().positive().default(16 * 1024),            // 单页字符上限
  maxWriteBytes: z.number().int().positive().default(1024 * 1024),         // 单次 write/replace/append 内容上限
  searchMaxFiles: z.number().int().positive().default(500),               // file-search 最多扫多少文件
  searchMaxBytes: z.number().int().positive().default(20 * 1024 * 1024),   // file-search 总扫描字节上限
  searchMaxResults: z.number().int().positive().default(50),               // file-search 最多返回多少条
  searchMaxLineChars: z.number().int().positive().default(500),            // 单行展示截断
  searchMaxKeywords: z.number().int().positive().default(10),              // 关键词个数上限
  workspaceMaxFiles: z.number().int().positive().default(500),             // workspace-files 最多列多少文件
  workspaceMaxDepth: z.number().int().positive().default(8),               // 工作区扫描最大目录深度
})
```

`normalizeConfig` 把每项 `Math.min(库里的值, env 上限)`；`precheck` 检查：

- 配置开关；
- `ObjectStorage.enabled`（仅 OSS 工具；未配置直接给"对象存储未配置"，workspace 工具仍可用）；
- `ctx.caller` 存在（否则没有会话上下文）。

env 硬上限：`AGENT_FILE_MAX_BYTES` / `AGENT_FILE_MAX_FILES` / `AGENT_FILE_MAX_TOTAL_BYTES` /
`AGENT_FILE_READ_MAX_BYTES` / `AGENT_FILE_PAGE_LINES_MAX` / `AGENT_FILE_PAGE_CHARS_MAX` /
`AGENT_FILE_WRITE_MAX_BYTES` / `AGENT_FILE_SEARCH_MAX_FILES` / `AGENT_FILE_SEARCH_MAX_BYTES` /
`AGENT_FILE_SEARCH_MAX_RESULTS` / `AGENT_FILE_WORKSPACE_MAX_FILES` / `AGENT_FILE_WORKSPACE_MAX_DEPTH`。

### 6.3 `file-submit`

**入参**

```ts
const SubmitInput = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 里要提交的文件路径（绝对或相对会话工作区）'),
  fileKey: z.string().min(1).max(255).describe(
    '会话内逻辑路径，如 reports/2026/q1.pdf；不得以 uploads/ 开头（保留给用户上传）；工具会自动拼上 userId 与会话 id',
  ),
})
```

**流程**

1. `caller` 缺失 → `precheck-failed`；
2. 解析 `filePath`（相对路径按会话工作区解析），`realpath` + 包含判断；
3. `stat`：必须是普通文件、`size > 0`、`size <= maxBytes`；
4. 敏感文件名黑名单（**纵深防御**）：`.env*` / `id_rsa*` / `*.pem` / `*.key` / `*.p12` / `credentials*`
   → `invalid-input`（"该文件看起来是密钥 / 凭据，不允许提交"）；
5. 校验并归一化 `fileKey`；**禁止 `uploads/` 前缀**（保留给入站）；拼对象 key；
6. 算 `sha256`，查 `(conversationId, path)`：
   - 已存在且 **sha256 相同** → 直接返回旧记录，`replaced: false`，**不重复上传**（durable 重放安全）；
   - 已存在且不同 → 覆盖对象 + 更新行，`replaced: true`，返回旧 sha256；
7. 配额检查（文件数 / 总字节，覆盖时排除旧行）；
8. `putObject({ key, body, contentType })`；
9. 事务 upsert `ai_files`（`INSERT ... ON CONFLICT (conversation_id, path) DO UPDATE`，`source='ai'`）；
10. upsert 失败：**新路径**尽力 `removeObject` 清孤儿；**覆盖已有路径**不删（旧对象已经被覆盖，
    删了会连旧版本也没有）。覆盖路径的对象与行可能短暂不一致 —— `file-download` 的 sha256 校验会报
    "对象已损坏"，下一次 submit 会修复；这种情况记 error 日志；
11. 返回 `{ fileKey, key, fileId, source: 'ai', bytes, mediaType, sha256, replaced }`。

**并发**：同一 `(conversationId, path)` 的提交用 Redis 锁串行（`RedisStore.acquireLock`，
key 取路径哈希，TTL 60s），不同路径互不影响。锁只覆盖"查旧行 → 上传 → upsert"这一小段，
不把 5MB 上传放进数据库事务。

**描述（给模型，≤380 字符）**

> 把 workspace 里的一个文件提交为**本会话的 AI 生成文件**（上传对象存储，用户可预览 / 下载）。
> 用户上传的文件已经自动进文件树，不要用这个工具重复提交。
> `filePath` 传 workspace 里的路径，`fileKey` 传会话内路径（不得以 `uploads/` 开头）；
> 工具会自动拼上 userId 与会话 id。同一个 `fileKey` 再提交会覆盖旧版本。不要提交密钥、凭据或工作区之外的文件。

### 6.4 `file-download`

**入参**

```ts
const DownloadInput = z.object({
  fileKey: z.string().min(1).max(255).describe(
    '本会话文件路径，从 file-list 拿；用户上传的是 uploads/{md5}{ext}',
  ),
  filePath: z.string().min(1).max(1024).optional().describe(
    '落盘位置（workspace 内绝对路径）；省略时入站放 uploads/...，AI 放 files/...',
  ),
})
```

**流程**

1. `caller` 缺失 → `precheck-failed`；
2. 校验 `fileKey`，按 `(conversationId, path)` 查 `ai_files`（含 `source='user'`）；
   **查不到 / 不属于本会话 → 同一句"本会话没有这个文件"**（不泄露存在性）；
3. `bytes > readMaxBytes` → `invalid-input`（提示用 `file-list` 看元数据，或换个小文件）；
4. 解析目标 `filePath`：默认 `source='user'` → `{workspace}/{path}`（`uploads/...`，通常已有物化副本）、
   `source='ai'` → `{workspace}/files/{path}`；先对**最近的已存在祖先** `realpath` 判包含，再 `mkdir -p`；
   目标已存在时对目标 `realpath`（防软链覆盖）；目标存在且是目录 → `invalid-input`；
5. 目标已存在且 sha256 一致 → `cached: true`，不重复下载（入站无 sha256 时比大小 / mtime）；
6. 缓存未命中：`getObject` → 校验 sha256（**入站 `sha256` 可空，跳过校验**；AI 产出不一致说明对象损坏，
   删除临时文件并报错）→ 写临时文件 → `rename`（原子覆盖）；权限 `0o600`；
7. 返回 `{ fileKey, key, source, filename, path, bytes, sha256, cached }`；
8. **不写 `ai_files`**：下载是本地缓存，不是一次提交；**返回里没有文件内容**（内容用 `read-file` 读）。

**描述**

> 把本会话的文件从对象存储**下载到 workspace**，返回本地路径；不返回内容。
> 入站附件通常已经物化到 `uploads/`，会直接命中缓存；AI 文件下载到 `files/`。
> 大文件下载后用 `read-file` 分页读；编辑用 `write-file` / `replace-file` / `append-file`，不要直接改 `files/` 缓存。

### 6.5 `read-file`

**入参**

```ts
const ReadFileInput = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内的文件路径（绝对或相对）'),
  offset: z.number().int().min(1).optional().describe('起始行（1-based）；默认 1'),
  limit: z.number().int().positive().max(500).optional().describe('这一页最多多少行；默认 200'),
})
```

**流程**

1. `caller` 缺失 → `precheck-failed`；
2. 解析 `filePath`（workspace 内）；`realpath` + 包含判断；必须是普通文件、非软链、文本类；
   `size > readMaxBytes` → `invalid-input`；
3. 算 `totalLines`；从 `offset` 起取 `limit` 行，受 `maxPageChars` 约束（超了少给几行，
   `hasMore` 仍为 true）；单行过长截断并标 `truncated`；
4. 返回 `{ path, totalLines, offset, limit, text, hasMore, nextOffset, truncated? }`；
5. 二进制文件 → `invalid-input`（"read-file 只读文本；二进制用 bash / python"）；
6. 不查 `ai_files`：这是 workspace 文件读取器，可以读 `uploads/`、`files/` 和 AI 自己写的 scratch。

**描述**

> 分页读 workspace 里的文本文件；默认 200 行 / 16KB，`offset` 1-based，返回 `totalLines` / `hasMore` / `nextOffset`。
> 大文件不要一次读完：先用 `file-search` 在整个工作区按关键词定位，再用 `offset` 读那一段。
> 只读文本；二进制用 bash / python。路径必须在本会话 workspace 内。

### 6.6 `file-search`

**入参**

```ts
const FileSearchInput = z.object({
  keywords: z.string().min(1).max(200).describe(
    '空格分隔的多个关键词；同一行必须全部出现（AND）；最多 10 个',
  ),
  caseSensitive: z.boolean().optional().describe('是否区分大小写；默认 false'),
  pathPrefix: z.string().max(255).optional().describe('只搜这个子目录，如 uploads/ 或 notes/；省略 = 整个 workspace'),
  maxResults: z.number().int().positive().max(200).optional().describe('最多返回多少条；默认 50'),
})
```

**流程**

1. `caller` 缺失 → `precheck-failed`；
2. 解析 `pathPrefix`（workspace 内，可省略）；关键词按空白切分、去重、限制 10 个、每个 ≤50 字符；
   大小写按 `caseSensitive` 归一；
3. 递归扫 workspace 的文本文件（跳过 `.git` / `node_modules` / `dist` / `build` / `.next` /
   `__pycache__` / `.venv`；跳过软链、二进制、> `readMaxBytes` 的文件）；
4. 总扫描文件数 ≤ `searchMaxFiles`、总字节 ≤ `searchMaxBytes`；超过就停并标 `truncated`；
5. 逐行匹配：**同一行必须包含全部关键词**（AND）；命中行截到 `searchMaxLineChars`；
6. 收集 `{ filePath, line, text }`（`filePath` 相对 workspace，`line` 1-based），最多 `maxResults` 条；
7. 返回 `{ items, totalMatches, truncated, scannedFiles }`；没命中返回空数组，不是错误。
   `maxResults` 最终取 `min(入参, searchMaxResults)`；`searchMaxFiles` / `searchMaxBytes` 是扫描硬上限。

```json
{
  "items": [
    { "filePath": "uploads/9f2c….md", "line": 128, "text": "## 计费规则" },
    { "filePath": "notes/plan.md", "line": 42, "text": "计费规则先按用量，再按阶梯" }
  ],
  "totalMatches": 2,
  "truncated": false,
  "scannedFiles": 12
}
```

- 关键词按空格切分，默认 **AND**（同一行全部出现）；要 OR 就分多次搜；短语不支持（空格是分隔符）。
- 扫描按路径升序；`files/` 是下载缓存，可能与 `uploads/` 内容重复，结果会各出现一次，按 `filePath` 区分。
- `totalMatches` 是本次实际扫到的命中数；`truncated=true` 表示还有文件 / 命中没扫完。

**描述**

> 在整个 workspace 的文本文件里搜关键词；空格分隔多个关键词（同一行必须全部出现），
> 返回文件路径 + 行号 + 行内容。大文件先搜后读：拿到行号后用 `read-file` 的 `offset` 读上下文。
> 跳过二进制 / 软链 / 依赖目录；结果有上限（默认 50 条）。

### 6.7 `write-file`

**入参**

```ts
const WriteFileInput = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标路径；父目录自动创建'),
  content: z.string().max(1_000_000).describe('完整文件内容（UTF-8）；整文件覆盖'),
})
```

**流程**

1. 解析 `filePath`；对**最近的已存在祖先** `realpath` 判包含；目标存在时拒绝软链 / 目录；
2. `Buffer.byteLength(content, 'utf8') <= maxWriteBytes`；含 `\0` → `invalid-input`；
   最终文件大小 `<= maxBytes`；
3. `mkdir -p` 父目录；写临时文件 → `rename`（原子覆盖）；权限 `0o600`；
4. 返回 `{ path, bytes, lines, created }`（`created` = 之前不存在）。

**描述**

> 把完整内容写入 workspace 文件（整文件覆盖）；父目录自动创建。
> 局部改用 `replace-file`，末尾追加用 `append-file`。只写文本；单次内容上限 1MB。
> 路径必须在本会话 workspace 内；不要写 `files/` 缓存（会被重新下载覆盖）。

### 6.8 `replace-file`

**入参**

```ts
const ReplaceFileInput = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径'),
  oldText: z.string().min(1).max(10_000).describe('要替换的原文；必须精确匹配（含空白）'),
  newText: z.string().max(1_000_000).describe('替换后的内容；空串 = 删除这段'),
  all: z.boolean().optional().describe('默认 false；多处匹配时默认拒绝，要求更长的唯一上下文'),
})
```

**流程**

1. 解析路径；文件必须存在、普通、非软链、文本类；`size <= readMaxBytes`；
2. 读出全文，统计 `oldText` 出现次数：
   - 0 → `invalid-input`（"没有找到要替换的内容"）；
   - >1 且 `all=false` → `invalid-input`（"匹配到 N 处；提供更长的上下文，或 all=true"）；
3. 替换后重新计算字节数：`<= maxWriteBytes` 且 `<= maxBytes`；
4. 写临时文件 → `rename`；返回 `{ path, replaced, bytes, lines }`；
5. 精确匹配，不做正则 / 模糊匹配；行尾不做归一化。

**描述**

> 在 workspace 文本文件里做**精确字符串替换**（不是正则）；默认要求 `oldText` 唯一匹配。
> 大文件先用 `file-search` 定位，再拿更长的唯一片段替换。
> 只改文本；单次内容上限 1MB；路径必须在本会话 workspace 内。

### 6.9 `append-file`

**入参**

```ts
const AppendFileInput = z.object({
  filePath: z.string().min(1).max(1024).describe('workspace 内目标文件路径；不存在则创建'),
  content: z.string().min(1).max(1_000_000).describe('追加内容（UTF-8）；不会自动加换行'),
})
```

**流程**

1. 解析路径；对**最近的已存在祖先** `realpath` 判包含；存在时必须是普通、非软链、文本文件；
   `当前大小 + 追加内容 <= maxBytes`；
2. `mkdir -p` 父目录；`appendFile`；权限 `0o600`；
3. 返回 `{ path, bytes, lines, created }`；
4. 并发：子 agent 也可以用这组工具；同一 agent 的追加是顺序的，但不同 run 写同一个文件不保证原子性，父 agent 需要分配独立路径。

**描述**

> 把内容追加到 workspace 文件末尾；文件不存在则创建。不会自动补换行。
> 要改中间用 `replace-file`，要整文件覆盖用 `write-file`。
> 只写文本；追加后不能超过单文件上限；路径必须在本会话 workspace 内。

### 6.10 `file-list`

无入参。按 `updated_at DESC` 返回本会话的文件：

```json
{
  "items": [
    { "path": "uploads/9f2c….pdf", "source": "user", "filename": "季度报告.pdf",
      "bytes": 12345, "mediaType": "application/pdf", "sha256": null,
      "updatedAt": "2026-11-11T09:00:00.000Z" },
    { "path": "reports/2026/q1.pdf", "source": "ai", "filename": "q1.pdf",
      "bytes": 23456, "mediaType": "application/pdf", "sha256": "…",
      "updatedAt": "2026-11-11T09:05:00.000Z" }
  ],
  "total": 2
}
```

- 默认 50 条、上限 200（与配额同一上限）；不分页（超出用 `total` 提示）；
- 只回元数据，不回 `key`（模型不需要；前端走会话详情）；
- `source` 区分用户上传 / AI 生成，`filename` 是展示名；入站的 `path` 是 `uploads/{md5}{ext}`，
  不是原始文件名；
- **只列 `ai_files`**，不列 workspace 里的 scratch 文件；要读/写 scratch 直接给路径；
- 描述：**列出本会话的文件（用户上传 + AI 生成）**；不确定有哪些、或忘了 `fileKey` 时用。

### 6.11 `workspace-files`

**入参**

```ts
const WorkspaceFilesInput = z.object({
  pathPrefix: z.string().max(255).optional().describe('只列这个子目录，如 uploads/ 或 notes/；省略 = 整个 workspace'),
  includeCaches: z.boolean().optional().describe('默认 false，隐藏 files/ 下载缓存与 uploads/ 入站副本'),
})
```

**流程**

1. `caller` 缺失 → `precheck-failed`；
2. 解析 `pathPrefix`（workspace 内，可省略）；扫 `{workspace}/{conversationId}`；
3. 跳过 `.git` / `node_modules` / `dist` / `build` / `.next` / `__pycache__` / `.venv`、软链、目录；
   默认跳过 `files/`（下载缓存）与 `uploads/`（入站副本，已在会话文件里）；`includeCaches=true` 才带；
   `pathPrefix` 明确指到 `files/` / `uploads/` 时自动视为包含该目录，否则永远为空；
4. **扁平列表**（不是树），按 `path` 升序：`{ items: [{ path, bytes, mtime }], total, truncated }`；
5. 上限 `workspaceMaxFiles`（默认 500）/ 深度 `workspaceMaxDepth`（默认 8）；超出 `truncated=true`；
6. 不读内容、不查 `ai_files`。

**描述**

> 列出 workspace 里的文件，**扁平列表**（不是树）；默认不显示 `files/` 缓存与 `uploads/` 入站副本。
> 返回相对路径 / 大小 / mtime，可直接给 `read-file` / `replace-file`；要搜索内容用 `file-search`。
> 只看会话文件（OSS）用 `file-list`。

### 6.12 错误语义

| 场景 | reason | 给模型的结论 |
| --- | --- | --- |
| 存储未配置（仅 OSS 工具） | `precheck-failed` | 对象存储未配置；workspace 工具仍可用 |
| 路径越界 / 软链逃逸 | `invalid-input` | 文件必须在本会话工作区内（`{root}`） |
| 文件不存在 / 目录 / 非普通文件 | `invalid-input` | 说清是哪个路径、什么问题 |
| 二进制文件被 `read-file` / `replace-file` 读到 | `invalid-input` | 只处理文本；二进制用 bash / python |
| 超单文件 / 会话配额 | `invalid-input` | 上限是多少，怎么处理（删旧文件 / 压缩） |
| 敏感文件名 | `invalid-input` | 看起来是密钥 / 凭据，不允许提交 |
| `file-submit` 的 `fileKey` 以 `uploads/` 开头 | `invalid-input` | 该前缀保留给用户上传 |
| `offset` / `limit` 非法 | `invalid-input` | 行号从 1 开始，单页最多 500 行 |
| `file-search` 关键词为空 / 超过 10 个 / 单个超长 | `invalid-input` | 空格分隔，最多 10 个，每个 ≤50 字符 |
| `file-search` 的 `pathPrefix` 越界 | `invalid-input` | 只能搜本会话 workspace 内的目录 |
| `workspace-files` 的 `pathPrefix` 越界 | `invalid-input` | 只能列本会话 workspace 内的目录 |
| `replace-file` 没找到 `oldText` | `invalid-input` | 原文必须精确匹配 |
| `replace-file` 多处匹配且 `all=false` | `invalid-input` | 提供更长的唯一上下文，或 `all=true` |
| `write-file` / `append-file` 超内容上限 | `invalid-input` | 单次 1MB / 文件 5MB |
| 文件不存在 / 非本会话（`file-download` / `file-list`） | `forbidden` | 本会话没有这个文件（不区分不存在与越权） |
| 对象存储读写失败 | `upstream` | 稍后重试（`retryable: true`） |
| 未预期异常 | `internal` | 内部错误，不把堆栈带给模型 |

`offset` 超过 `totalLines` 返回空页 + `totalLines`，不报错（模型据此修正行号）。
`file-search` 没命中返回空数组，不是错误。

### 6.13 提示词纪律：文件操作只用文件工具

写在 `apps/server/src/modules/ai/core/prompts/templates/partials/requirements.eta`（所有 agent 共用，
按 `read-file` 是否存在条件渲染）：

```eta
{{ if (it.tools.some(function (tool) { return tool.key === 'read-file' })) { }}
## 文件操作（只用文件工具）

- 读写文件内容只用 `read-file` / `write-file` / `replace-file` / `append-file`；
  列会话文件用 `file-list`，列工作区文件用 `workspace-files`；上传 / 下载用 `file-submit` / `file-download`；
- **不要用 `bash` 的 `cat` / `sed` / `awk` / `echo >` / `tee` / `python` 读写文件**：
  会绕过 workspace 边界、大小限制与文件索引，用户看不到、审计也查不到；
- 会话文件（OSS）先 `file-download` 到工作区，再 `read-file` / `file-search`；工作区文件直接读；
- 大文件先 `file-search`（空格分隔关键词）再 `read-file` 分页读；不要一次读完；
- 用户上传的原文件已经在文件树 / `uploads/` 里，不要用 `file-submit` 重复提交；修改后的新文件换 `fileKey` 再提交。
{{ } }}
```

口径：

- **为什么写进全局提示词而不是工具说明**：这是跨工具的纪律（`bash` 也能读写文件），
  写在每个工具说明里会重复，且模型可能只看当前工具的说明；全局段每轮都在。
- **条件渲染**：没有文件工具的 agent 不该收到这段（避免提示词膨胀与"点了不存在的工具"）。
- **`bash` 仍然可用**：用于执行命令 / 测试 / 计算；但读写文件内容必须走文件工具。
  这条是提示词纪律，不是硬隔离 —— 真要让 `bash` 读写不了文件，得靠容器 / 只读挂载（不在本期）。
- 工具说明里不重复这段；`file-submit` 的描述里保留"用户上传的已自动进文件树，不要重复提交"这一句。

> 提示词成本：约 6 行 / 每轮；换来的是文件操作可审计、可索引、不越界。

## 7. 存储能力补齐

### 7.1 `ObjectStorage.putObject`

`packages/kits/src/storage/object-storage.ts` 目前只有
`getPresignedUrl` / `getDownloadUrl` / `getTemporaryCredentials` / `getObject` / `removeObject`，
**没有服务端写入口**。新增：

```ts
putObject(input: {
  key: string
  body: Buffer
  contentType?: string
}): Promise<{ key: string }>
```

- S3：`PutObjectCommand({ Bucket, Key, Body, ContentType })`（`providers/s3.ts` 已 import 该命令）；
- COS：`providers/cos.ts` 对应实现；
- 统一走 `guard('putObject', …)`，失败包成 `ObjectStorageError`；
- 本期单文件 ≤5MB，Buffer 进内存完全够；真要放大上限再改流式 / 分片。

### 7.2 下载强制 attachment

`getDownloadUrl` 增加可选 `filename`：

```ts
GetStorageDownloadUrlSchema = z.object({
  key: z.string(),
  filename: z.string().max(255).optional(),
})
```

S3 设 `ResponseContentDisposition: attachment; filename*=UTF-8''<encoded>`；
COS 同理。跨域时 `<a download>` 不保证生效，下载按钮必须走这个接口。

### 7.3 媒体类型

服务端按 `fileKey` / `filePath` 后缀推断，映射不到就 `application/octet-stream`；
**不信模型自述**（与附件链路同一姿态）。常见：pdf / png / jpg / webp / gif / md / csv / json /
txt / zip / docx / xlsx / pptx。

## 8. 接口与前端

### 8.1 会话详情

`AgentConversationSchema` 增加可选 `aiFiles: AgentFileNode[]`：

- `conversation/detail` 查 `ai_files` → `buildFileTree` → 返回；最多 200 个叶子；
- `conversation/list` **不返回** `aiFiles`，避免列表页把每棵树都拉出来；
- 工具提交成功后，前端 `invalidateQueries(['agentConversation', conversationId])`，
  右栏树自动刷新；工具卡本身直接用工具出参渲染，不等详情刷新。

### 8.2 SDK

`@repo/sdk` 的 `client.agent.*` 补 `aiFiles` 类型 + `filePreview({ conversationId, path })`；
`client.storage.getDownloadUrl({ key, filename })` 补 `filename`。改完 `pnpm build:pkgs`。

### 8.3 右栏「文件」tab：会话文件 + 工作区

`RightPanelTab` 加 `'files'`，与 `system` / `skills` / `plan` / `subagents` 同级。
tab 内顶部用 segmented control 分两个视图 —— 两边的生命周期与动作不同，不能混成一棵树：

| 视图 | 数据源 | 是什么 | 能做什么 |
| --- | --- | --- | --- |
| **会话文件（OSS）**，默认 | `conversation/detail` 的 `aiFiles` | 持久文件：用户上传 + AI 提交 | 预览 / 下载 / 来源徽标 / 按来源筛选 |
| **工作区（临时）** | `POST /agent/file/workspace` | AI 正在写的 scratch、下载缓存、入站副本 | 树形浏览 / 预览 / 下载 / 刷新 |

**会话文件**：

- 树形，文件行显示名字 / 大小 / 更新时间 +「用户上传」/「AI 生成」徽标；
- 预览 / 下载按 §8.4；
- 空态：「本会话还没有文件。发附件或 AI 提交后出现。」
- 发送带附件的消息后 invalidate 会话详情：入站登记发生在服务端，前端不等工具卡。

**工作区**：

- 树形来自 §8.8，文件行显示相对路径 / 大小 / mtime；
- 默认隐藏 `files/`（下载缓存）与 `uploads/`（入站副本，已在会话文件里）；
  顶部 toggle「显示缓存 / 入站副本」才显示；
- 图片 / PDF / 视频 / 音频按 §8.4 矩阵预览（先走 `workspace-link` 物化到 OSS，再让浏览器直连；不走后端字节流）；
  文本 / Markdown / 代码 / HTML 走 §8.7 的 `source='workspace'`；Office OOXML 前端渲染；老 `.doc` / `.ppt` 只下载；
- 行内操作：预览 / 下载；下载的是临时副本，长期保留仍要 `file-submit` 到会话文件；
- 顶部「刷新」按钮；每轮结束 / 文件工具结果后 invalidate `['agentWorkspace', conversationId]`；
- 空态：「工作区还没有文件。AI 写文件后出现。」
- **多实例提醒**：工作区是本地盘，请求可能落到别的 Pod 看到空目录；会话文件（OSS）才是事实源；
  单实例部署下正常。

**为什么分两个视图**：会话文件可预览 / 下载 / 长期保留；workspace 文件是临时 scratch，换 Pod 可能就没了。
混在一棵树里会让用户误以为 workspace 文件也能下载 / 长期保存。分视图 + 明确文案，避免这个误解。

- 目录数量 / 文件数量做小徽标；会话文件 badge 常驻，工作区 badge 懒加载。

### 8.4 预览矩阵

| 类型 | 预览方式 | 说明 |
| --- | --- | --- |
| 图片（png / jpg / webp / gif） | `<img>` | — |
| SVG | **只下载** | 可执行脚本，禁止内联到 `<img>` / `<iframe>` |
| 视频 / 音频 | 原生 `<video>` / `<audio>` | — |
| PDF | `<iframe>` | 浏览器自带阅读器 |
| **HTML（html / htm）** | **沙箱 iframe** | 复用 `SandboxFrame`：`allow-scripts`、**不带** `allow-same-origin`、CSP `default-src 'none'`；**不能**用普通 `<iframe src>` 直出 |
| Markdown | Markdown 组件 | 文本走 §8.7 的预览接口，避免 CORS |
| 代码 / 纯文本 / CSV / JSON | 只读 CodeMirror 或 `<pre>` | 只读，不提供编辑；文本走 §8.7 |
| pptx | `pptx-preview` 前端渲染 | 前端直接 fetch 对象存储链接拿 ArrayBuffer；`.ppt` 老格式仍下载 |
| docx | `docx-preview` 前端渲染 | 同上；老 `.doc` 不支持 |
| xlsx / xls | SheetJS 解析后用 React 表格渲染 | 同上 |
| 其他 | 只下载 | 显示"当前类型不支持在线预览" |

**HTML 预览的三个前提**：

1. **文本从后端来**：前端要拿到 HTML 文本才能放进沙箱 `srcdoc`。走 §8.7 的预览接口；
   Office 二进制则直接 fetch 对象存储链接（S3 / COS provider 启动时会配置 GET / HEAD CORS）。
2. **沙箱复用围栏那套**：`SandboxFrame` 从 `ai-elements/markdown-fences/` 提到
   `packages/ui/components/` 并补导出（`ai-markdown-fences.md` §7 预留的后续项）；
   `html` 围栏退役后，它是 **HTML 文件预览与 `gsap` 围栏共用的沙箱**。
3. **单文件**：外链资源会被 CSP 拦、相对路径找不到；多文件站点预览是另一个能力，不在本期。
4. **完整文档也要注入 CSP**：HTML 文件可能是 `<!doctype html>…` 的完整文档，`SandboxFrame` 要把
   CSP `<meta>` 注入到文档最前面，不能直接 `srcdoc` 整份 HTML 而不带 CSP（只取 `<body>` 会丢
   `<head>` 里的样式 / 脚本，不推荐）。

**与 `html` 围栏的切换顺序**：先让文件树能沙箱预览 `.html`，再从 prompt / renderers 里移除
`html` 围栏；否则中间态模型没有页面预览能力。旧消息里的 `html` 围栏可以保留渲染（软退役），
等文件预览稳定后再删代码。

以上矩阵对**会话文件**与**工作区**都适用：会话文件的图片 / 视频 / 音频 / PDF 用 `formatStorageUrl` 直链；
工作区的二进制先走 `workspace-link` 物化成临时 OSS 对象，再由浏览器直连；HTML 两边都走文本沙箱；Office OOXML 走「对象存储直链 → 前端第三方渲染器」，不经过后端字节转发；老 `.doc` / `.ppt` 只下载。

会话文件的图片 / 视频 / 音频 / PDF 预览地址用 `formatStorageUrl(key)`（桶是 public-read，直链即可；
见 §9.3 的取舍）；HTML / Markdown / 代码走 §8.7 的文本接口。

### 8.5 下载

```ts
const { url } = await client.storage.getDownloadUrl({ key, filename })
window.location.href = url
```

- 预签名 URL 1 小时有效；
- `filename` 传 `ai_files.filename`（入站原始名 / AI 的 `path` 最后一段），不要用入站 `path` 里的 md5 段；
- 不在前端拼 key：`key` 来自会话详情 / 工具出参；
- **工作区文件**下载走 `workspace-link`（`download:true`，临时副本；长期保留先 `file-submit` 到会话文件）。

### 8.6 工具卡与历史

- `file-submit`：文件卡（图标 / 名字 / 大小）+ 预览 / 下载；`replaced` 时标「已覆盖旧版本」；
- `file-download`：显示「已下载到 `{path}`」+ 文件大小；`read-file` / `write-file` / `file-search` / `workspace-files` 用普通工具卡（路径 / 关键词 / 数量）；
- 历史回看：`tool-result` 的 payload 里带同样的元数据，卡片不用另查库；
- 不把文件内容塞进工具卡（只展示元数据）。

### 8.7 文本预览接口（会话文件 / 工作区）

`POST /agent/file/preview`（`AnyAuthGuard` + 会话归属）：

- 入参 `{ conversationId, path, source?: 'ai' | 'workspace' }`，默认 `source='ai'`；
- `source='ai'`：按 `(conversationId, path)` 查 `ai_files`，取 `key` → `getObject`；
- `source='workspace'`：`path` 是 workspace 相对路径；做 §5.3 路径包含判断，读本地文件；
- 只允许文本类（`text/*` + 常见代码 / md / csv / json 后缀）；超过 1MB 截断并明示（`truncated: true`）；
- 返回 `{ text, mediaType, truncated }`；
- **HTML 也走这里**：前端把 `text` 交给 `SandboxFrame` 的 `srcdoc`，不要用 `formatStorageUrl` 直链 iframe；
- 前端 `queryKey=['aiFilePreview', conversationId, source, path]`，同一文件重复打开不重复拉。

为什么文本仍走后端：文本预览要统一做 1MB 截断、路径包含与章节安全判断；Office 二进制才是直连 OSS（会话文件用 `getDownloadUrl`，工作区先物化成临时对象拿链接）。前端不用为不同来源写两套取文本逻辑。
图片 / PDF / 视频 / 音频不走这个接口（会话文件用直链；工作区先用 `workspace-link` 物化再直连）。

### 8.8 工作区列表接口

`POST /agent/file/workspace`（`AnyAuthGuard` + 会话归属）：

- 入参 `{ conversationId, includeCaches?: boolean }`；
- 扫 `{workspace}/{conversationId}`，返回 `{ items: [{ path, bytes, mtime }], total, truncated }`；
  `path` 相对 workspace，前端按 `/` 组树；
- 跳过 `.git` / `node_modules` / `dist` / `build` / `.next` / `__pycache__` / `.venv`、软链、目录；
- 默认跳过 `files/`（下载缓存）与 `uploads/`（入站副本，已在会话文件里）；`includeCaches=true` 才带；
- 上限：500 个文件 / 深度 8；超出 `truncated=true`；
- **多实例**：读本地盘，请求可能落到别的 Pod；会话文件（OSS）是事实源。

### 8.9 工作区内容流（预览 / 下载）

`GET /agent/file/workspace-content?conversationId=&path=&download=`

- `AnyAuthGuard` + 会话归属；`path` 必须在 workspace 内；软链拒绝；单文件 ≤5MB；
- `createReadStream` 按扩展名给 `Content-Type` 与 `Content-Length`；`Cache-Control: no-store`；
  `X-Content-Type-Options: nosniff`；视频 / 音频支持 `Range`（拖动进度条）；
- `download=1` 或 Office / 未知类型 → `Content-Disposition: attachment`；图片 / PDF / 视频 / 音频默认 `inline`；
- **HTML / SVG 不允许 inline**：HTML 走 §8.7 的文本预览 + 沙箱；SVG 只下载（`attachment`）；
- **鉴权**：GET 给 `<img>` / `<video>` / `<audio>` / `<iframe>` 用，按身份读 `access-token`
  / `admin-access-token` cookie（`extractToken` 的 user / admin 分支；与 SSR 同一套；`SameSite=Lax`，
  admin 与 API 需同站）。跨站部署下前端改用 fetch blob
  （带 Authorization）再 `URL.createObjectURL`；
- **多实例**：读本地盘，可能落到别的 Pod；会话文件走 OSS 直链不受影响。

### 8.10 管理员「文件管理」独立页（`/main/ai/files`）

跨会话看**所有文件**，不先选会话；菜单在「AI → 文件管理」。

- `POST /agent/file/admin/list`（`AdminAuthGuard`）：分页全量 `ai_files` + 所属会话标题；
  `keyword` 同时匹配 `filename` / `conversations.title`；`from` / `to` 按 `created_at` 闭区间；
  `sortBy=size` + `sortOrder` 支持按大小排序；
- `POST /agent/file/admin/stats`（`AdminAuthGuard`）：与列表共用 keyword / 时间范围，
  返回总数 / 总字节 / 用户上传与 AI 生成的条数与字节 / 涉及会话数；
- `POST /agent/file/admin/preview`（`AdminAuthGuard`）：按 `fileId` 读任意会话的文本，
  给后台预览用（图片 / PDF / 视频 / 音频走对象存储 URL + `FilePreview`；HTML 走 `SandboxFrame`）；
- `POST /agent/file/workspace-link`（`AnyAuthGuard`）：工作区文件先物化成 `_preview/` 下的临时 OSS 对象，
  只返回链接；`download` 控制 inline / attachment。前端直接 fetch 该链接，后端不转发字节；
  临时对象由 `FileService` 启动时及每 6 小时清扫一次（24h TTL）；
- 页面主体是 DataTable：文件名 + path、所属会话（可跳回聊天）、来源、大小、创建时间、
  预览 / 下载；时间范围用 `DateRangePicker`（`Calendar` + `Popover` 封装），不用原生 date input；
- 预览弹窗：左侧当前文件清单（后台为当前页，聊天右栏为当前视图的全部文件），
  顶部「上一个 / 下一个」（支持 `←` / `→`），右侧全屏内容；HTML 用 `SandboxFrame` 的无 chrome 模式；
- 指标卡在**控制台 dashboard** 的「文件用量」区：文件总数 / 总占用 / 用户上传 / AI 生成，
  数据来自同一份 stats；文件页不再重复放指标卡；
- 管理员列表会返回对象存储 `key` 供下载；该 key 仍只用于已鉴权页面，不写日志 / 不外发。

## 9. 安全与审计

### 9.1 权限

- `userId` / `conversationId` **只从 `ctx.caller` 取**，模型传不了；
- `read` / `list` 只查本会话；跨会话的 `path` 查不到（同一句"没有这个文件"）；
- 管理员会话的 key 是 `admin/…`，前台用户下载会 403（`assertDownloadKey` 前缀不匹配）；
- 会话归属仍由 `AgentConversationService.requireOwned` 保证（HTTP 侧）；
- **入站登记前**，附件 key 已经过 `AttachmentKeyPolicy.assertOwned`；越权 key 不会进 `ai_files`；
  入站行的 `user_id` 也只从鉴权上下文取；
- **工作区接口**（`/agent/file/workspace`、`preview` 的 `source='workspace'`、`workspace-content`）
  同样先 `requireOwned`，再做 §5.3 的路径包含判断；只读本会话目录。

### 9.2 路径与文件

- `filePath` 必须 `realpath` 后在会话工作区内；软链逃逸拒绝；
- `fileKey` 逐段清洗；禁止 `..`、绝对路径、空段、控制字符；
- 只提交普通文件（`stat.isFile()`），目录 / 设备文件 / 套接字拒绝；
- 敏感文件名黑名单（`.env*` / `id_rsa*` / `*.pem` / `*.key` / `*.p12` / `credentials*`）；
- `read` 下载后校验 sha256；**入站 `sha256` 可空，跳过校验**；AI 产出不一致说明对象损坏；
- `filename` 只用于展示 / `Content-Disposition`；下载前剥掉 CR/LF、引号与控制字符，防 header 注入；
- 工作区列表 / 预览只读 `{workspace}/{conversationId}`，跳过软链；文本预览只允许文本类；
- `workspace-content` 只作为兼容下载接口保留；前端预览 / 下载已统一走 `workspace-link`；HTML / SVG 仍强制 `attachment`，不允许 inline；
- 落盘权限 `0o600`，临时文件 + `rename` 原子写。

### 9.3 桶的 public-read（必须知道的取舍）

`providers/s3.ts` 的 `ensurePublicReadBucket` 给桶设了 `Principal: *` 的 `s3:GetObject`。
后果：**知道 key 就能下载**，预签名 URL 只是"带过期时间的方便入口"，不是唯一门禁。

- AI 文件 key 含 `userId` / `conversationId`（nanoid），入站 key 含 `userId` + 内容 md5；都不可枚举，
  但**不要**把 key 放进公开页面、分享链接、对外日志或错误文案；
- 业务日志只记 `conversationId` / `path` / `bytes` / `sha256`，不记完整 key；
- 如果文件需要真正私有：改桶策略为私有 + 前端全部走预签名（头像 / 附件 / 预览一起改），
  这是一次独立的存储策略变更，不在本期范围。

### 9.4 审计

- 工具入参 / 出参全量落时间线（`tool-call` / `tool-result`）：`path` / `key` / `bytes` / `sha256` /
  `replaced`，**没有字节**；
- `ai_files` 行记 `source` / `run_id` / `tool_call_id` / `user_id`，能对上"哪一轮、谁、以什么来源"；
- 业务日志事件：`ai.file.submitted` / `ai.file.registered`（入站）/ `ai.file.read` /
  `ai.file.upload_failed`（conversationId、source、path、bytes、sha256、durationMs、结果）；
- 指标：AI 模块当前未接 telemetry，只记结构化日志（与现状一致）。

## 10. 生命周期

### 10.1 提交 / 覆盖 / 重放

- 幂等：`(conversation_id, path)` 唯一 + `sha256` 相同即 no-op（AI）；入站按 `(conversation_id, path)`
  upsert，同一内容重复发送不新增行，只更新 `filename` / `updated_at`；
- **入站物化**：`{workspace}/uploads/{md5}{ext}` 已存在且大小一致 → 跳过；否则从对象存储重新写
  （换 Pod / 目录被删后的自愈路径）；
- durable 重放：同一工具调用重跑不会产生第二份对象 / 第二行；
- 覆盖（仅 `source='ai'`）：对象 key 不变，`PutObject` 直接覆盖；`ai_files` 更新 `bytes` / `sha256` /
  `media_type` / `updated_at`；旧字节不可恢复（除非桶开版本控制）；
- 提交失败：上传前失败 → 什么都没变；上传后 upsert 失败 → 新路径删孤儿，覆盖路径保留现状并报错。

### 10.2 删除

- **本期没有删除工具**；
- **会话软删（`AgentConversationService.remove`）** 按顺序做四件事，全部 best-effort、不阻塞删除：
  1. 软删会话（既有行为）；
  2. `FileService.cleanupConversation` 删工作区 `{root}/{conversationId}`（含 `uploads/` 入站副本）；
  3. `ai_files` 行软删（保留审计，入站 / 出站都软删）；
  4. **只删 `source='ai'` 的对象**；`source='user'` 的对象**不删**（内容寻址，可能被其他会话引用；
     引用计数 / 用户级清理后续再做），失败记日志，靠 TTL 兜底。
- 与正在跑的 `file-submit` 的竞态：`remove` 先 `cancelActive`，工具收到 AbortSignal 会中断；
  仍然写进来的孤儿由 TTL 清理；submit 入口也可以查一次会话未删（防御）。
- 多副本：工作区删除只影响处理请求的 Pod，其他 Pod 的本地副本靠 TTL。

实现：`AgentConversationService` 构造器注入 `FileService`（显式 `@Inject`），在 `remove` 的
`softDelete` 之后 `try { await this.files.cleanupConversation(id) } catch { log.error }`；
清理失败不回滚会话删除。

### 10.3 孤儿与清理

| 情况 | 处理 |
| --- | --- |
| 表里有行、对象没了 | 下载时报"对象不可用"；定时任务按行 `HeadObject` 标记 / 清理 |
| 对象在、表里没行 | **AI 对象**：上传后 upsert 失败的孤儿，按会话前缀列对象与表比对，删除无主对象；**入站对象**：内容寻址、可能被其他会话引用，不按此规则删 |
| 工作区残留 | 按会话目录 TTL 清理（默认 7 天未活动） |
| 会话软删 | 工作区同步删（尽力）+ `ai_files` 行软删 + **只删 `source='ai'` 的对象**；入站对象保留 |
| 入站对象 | 用户级、内容寻址；不随会话删；引用计数 / 用户级 TTL 清理后续再做 |

### 10.4 多副本

- `ai_files` / 对象存储在共享存储，跨实例一致；
- 工作区在 Pod 本地盘：换 Pod 后 `read` 缓存未命中 → 重新下载；
- 一轮 run 粘在单个实例上（`runs` 的部分唯一索引），不存在"同一轮两个实例同时写工作区"；
- 不假装工作区跨实例一致（与 AI memory / 流在进程内是同一类限制）；
- 右栏「工作区」视图 / `workspace-content` 是本地盘：HTTP 可能落到别的 Pod 看到空目录，
  **会话文件（OSS）才是事实源**。

## 11. 迁移与实施顺序

### 11.1 迁移

1. 新建实体 `AiFileEntity`（`ai_files`），登记进 `root.module.ts` 的 `entities`；
2. `pnpm --filter @app/server db:generate AiFiles`；
3. 迁移文件首行改 `import type { MigrationInterface, QueryRunner }`（ESM 下 value import 跑不起来）；
4. 检查部分索引条件（本期没有 partial unique，只有普通唯一键）；
5. 执行迁移，`\d ai_files` 核对列 / 唯一键 / 索引。

### 11.2 顺序

| 步 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | kits：`putObject` + `getDownloadUrl({ filename })`；shared：`GetStorageDownloadUrlSchema` 加 `filename` | — |
| 2 | `ai_files` 实体 + 迁移 + 仓储 | 1 |
| 3 | workspace 统一根 + `resolveInsideWorkspace` + `bash` 按会话根改造（退役 `BashConfig.workDir`） | — |
| 4 | `FileService` / `FileRepository` / `FileTools` + `registerInbound` / `materializeInbound`（聊天链路登记并入物化）+ 会话删除清理钩子 + `TOOL_KEYS` + `AGENT_TOOL_GROUPS` + agent 授权 | 1–3 |
| 5 | shared：`FileSource` 字典（用户上传 / AI 生成）+ `AgentFileNode` / `AgentFileModel`（含 `source` / `filename`）/ `aiFiles` + `buildFileTree`；`pnpm build:pkgs` | 2 |
| 6 | 会话详情带 `aiFiles`；文本预览接口（ai / workspace）；工作区列表 + 内容流接口；`SandboxFrame` 提取 + 前端「文件」tab（会话文件 / 工作区）+ 提示词纪律 | 4–5 |
| 7 | 测试、设计文档、开发日志、记忆 | 全部 |

## 12. 测试矩阵

### 12.1 工具单测（`test/ai-tools/file-*.test.ts`）

| 用例 | 断言 |
| --- | --- |
| 提交普通文件 | 对象 key 正确、`ai_files` 一行、出参含 sha256 |
| `filePath` 越界 / 软链逃逸 | `invalid-input`，**没有调用** `putObject` |
| 0 字节 / 目录 / 设备文件 | `invalid-input` |
| 超单文件上限 | `invalid-input` |
| 敏感文件名 | `invalid-input` |
| 多级 `fileKey` | key / path 正确，树两层 |
| `uploads/` 前缀 | `file-submit` 拒绝（保留给入站） |
| 入站登记 | `source='user'`、`path=uploads/{md5}{ext}`、同一内容重复发送不新增行 |
| 入站读取 | `file-download` 命中物化副本；`read-file` 能读 `uploads/` 文本 |
| 入站配额 | 入站 + 出站合计 200 个 / 100MB |
| 同路径同 sha256 | 不重复上传，`replaced: false` |
| 同路径不同 sha256 | 覆盖，`replaced: true` + 旧 sha256 |
| 会话配额 | 超 200 个 / 100MB 拒绝 |
| 存储未配置 | `precheck-failed` |
| file-download 正常 | 文件落盘、sha256 一致、返回 path |
| file-download 非本会话 / 不存在 | `forbidden`，不调 `getObject` |
| file-download 缓存命中 | 不重复下载 |
| file-download 同路径不同内容 | 覆盖、`rename` 原子 |
| file-download 超 readMaxBytes | `invalid-input` |
| read-file 分页 | `offset` / `limit`、`totalLines` / `hasMore` / `nextOffset` 正确 |
| read-file offset 越界 | 空页 + `totalLines`，不报错 |
| read-file 单页超 `maxPageChars` | 少给几行，`hasMore` 仍为 true |
| read-file 二进制 | `invalid-input` |
| file-search 多关键词 AND | 只有同时包含全部关键词的行命中；返回 `{filePath, line, text}` |
| file-search 无命中 | 空数组，不是错误 |
| file-search 跳过非文本 | 二进制 / 软链 / 依赖目录不出现；`pathPrefix` 过滤生效 |
| file-search 上限 | `maxResults` / `searchMaxFiles` / `searchMaxBytes` 触发时 `truncated=true` |
| workspace-files 扁平列表 | 只列文件、按 path 升序；默认隐藏 `files/` / `uploads/`，`includeCaches` 生效 |
| workspace-files 前缀 / 上限 | `pathPrefix` 过滤；越界 `invalid-input`；超 `workspaceMaxFiles` / 深度 `truncated=true` |
| write-file 新建 / 覆盖 | 内容一致、`created` 正确、原子写 |
| write-file 越界 / 软链 / 超限 | `invalid-input`，不写盘 |
| replace-file 唯一匹配 | 替换成功、其余内容不变 |
| replace-file 没找到 / 多处匹配 | `invalid-input`，不写盘 |
| append-file 新建 / 追加 | 内容追加、`created` 正确 |
| append-file 超上限 | `invalid-input` |
| file-list 排序 / 上限 | 最新在前、`total` 正确 |

### 12.2 注册机标准测试集

- `test/ai-tools-battery.test.ts` 的 `groups` 加 `FileTools`；
- `VALID_INPUT_TEMPLATES` 加九个 key 的合法入参（漏加会红）；
- 说明文本 ≤380 字符、`config.parse({})` 默认值齐全；子 agent 可用（没有 `child: 'deny'`）。

### 12.3 集成 / e2e

- 仓储：唯一键冲突 → upsert；软删后重新提交恢复 `deleted_at = null`；
- 入站：发带附件的消息 → `ai_files` 一行 `source='user'`、`path=uploads/...`、`filename` 是原名；
  `{workspace}/uploads/{md5}{ext}` 有本地副本；同一内容再发一次 → 不新增行、不重复写副本；
- 删除会话：工作区目录消失（含 `uploads/`）、`ai_files` 行软删；**`source='ai'` 对象删除、
  `source='user'` 对象保留**；删不掉时 TTL 兜底；
- 换 Pod / 手工删副本后：`file-download` 能从对象存储重建，不假设本地副本还在；
- 删除与正在跑的 submit 的竞态：先 `cancelActive`，工具中断；串行路径要覆盖；
- 会话详情：`aiFiles` 树结构、排序、空态、`source` 标注；
- 工作区接口：`workspace` 扁平列表 / `includeCaches` / 深度与文件数上限；`workspace-content`
  图片 / PDF `inline`、Office `attachment`、HTML / SVG `attachment`、路径越界拒绝；
- e2e：mock 模型加 `[file]` 标记 → 提交 → MinIO 有对象、`ai_files` 有行、
  时间线 payload **没有字节**；再 `file-download` + `read-file` → 工作区有文件、sha256 一致；
- e2e：带附件消息 → `source='user'` 行 + `uploads/` 副本 + `read-file` 可读；删会话后副本消失、对象还在；
- e2e：1w 行 md 文件 → `read-file` 第一页 200 行 + `totalLines≈10000`；`file-search` 命中行号后
  用 `offset` 读该段；**整份文件从不进上下文**。

### 12.4 前端

- `buildFileTree` 纯函数单测（多级 / 同名文件 / 排序）；
- 「文件」tab 两个视图切换、来源徽标 / 筛选、预览弹窗、下载按钮（mock `getDownloadUrl`）；
- 工作区树、缓存 toggle、刷新、空态；工作区预览按 §8.4（文本走 `source='workspace'`，二进制走 §8.9）；
- 多实例空工作区时提示以会话文件为准；
- HTML 预览走沙箱：断言 `data-fence` / sandbox 属性、**没有**直接用 `formatStorageUrl` 的 `<iframe src>`；
- 工具卡 `replaced` / `file-download` 路径展示；`read-file` / `write-file` 用普通工具卡；
- 历史回看卡片。

### 12.5 门禁

```bash
pnpm typecheck && pnpm test && pnpm check:ui && pnpm check:inject && pnpm check:mastra
```

改了 `@repo/shared` 先 `pnpm build:pkgs`；改了 `core/tools` 跑 `pnpm check:mastra`（禁 `@mastra`）。

## 13. 取舍与未做

| 项 | 状态 | 说明 |
| --- | --- | --- |
| `conversations.ai_files` JSONB | **否决** | 并发丢更新、查询 / 清理难；改用 `ai_files` 表 |
| `content` 直传文本 | 未做 | 工具参数保持 `filePath` + `fileKey` 一种形状；`bash` 关闭时的文本文件后续再加 |
| 版本历史 | 未做 | 同 `path` 覆盖；要回滚把版本号拼进 `fileKey` |
| 跨会话读取 / 文件中心 | 未做 | 只在本会话；跨会话要用户显式选择，不能让模型猜 |
| Office 在线预览 | 部分 | DOCX / XLSX / XLS / PPTX 已用前端库；老 `.doc` / `.ppt` 仍只下载 |
| 删除 / 撤回工具 | 未做 | 依赖会话删除或后续单独设计 |
| 私有桶 | 未做 | 现状 public-read；要私有得改桶策略 + 全链路预签名 |
| 大文件流式上传 | 未做 | 本期 Buffer ≤5MB；更大走流式 / 分片 |
| 大文件自动摘要 | 未做 | 工具只提供分页 / `file-search` 定位；整份总结靠模型分段读 + 上下文压缩，或用户缩小范围 |
| 工作区文件编辑（面板） | 未做 | 面板只读；编辑由 AI 用 `write-file` / `replace-file` / `append-file` |
| 工作区跨实例 | 限制 | 工作区是本地盘；多实例下请求可能落到别的 Pod 看到空目录；会话文件（OSS）为准 |
| 用户级总配额 | 未做 | 先做会话级；跨会话配额后续 |
| 入站对象引用计数清理 | 未做 | 会话删除只软删入站行、不删对象（内容寻址共享）；后续按引用计数或用户级 TTL 清 |
| 入站双写一致性 | 缓存 | 对象存储是事实源；`{workspace}/uploads/` 是可丢可重建的本地副本，不做分布式事务 |
| 统一交付物索引（file / record / url / text） | 未做 | 文件管理只负责文件；记录 / 链接由业务工具与前端卡片承担；要统一视图再加 `ai_artifacts` 只读索引（§1.4） |

## 14. 验收清单

- [ ] `ai_files` 表 + 实体 + 迁移 + 唯一键 `(conversation_id, path)`；
- [ ] `ObjectStorage.putObject` 在 S3 / COS 两个 provider 可用，失败包成 `ObjectStorageError`；
- [ ] `getDownloadUrl({ key, filename })` 带 `Content-Disposition`；
- [ ] workspace 根统一，`bash` 与文件都按 `{root}/{conversationId}` 工作；
- [ ] 九个工具注册、授权、进标准测试集；`file-submit` 拒绝 `uploads/` 前缀；
- [ ] `read-file` 按行分页（`offset` / `limit`、`totalLines` / `hasMore` / `nextOffset`），**不返回全文**；
- [ ] `file-search` 支持空格分隔的多个关键词（AND），返回文件路径 + 行号 + 行内容；二进制 / 软链 / 依赖目录跳过；
- [ ] `write-file` / `replace-file` / `append-file` 路径守卫、内容上限、原子写；
- [ ] 1w 行文件：分页 + `file-search` 定位可用，整份内容从不进上下文；
- [ ] 入站附件在发消息时登记为 `source='user'`（`path=uploads/{md5}{ext}`），文件树可见、可读、可预览；
- [ ] 入站附件**物化**到 `{workspace}/uploads/{md5}{ext}`；对象存储保留原文；换 Pod 后能由 `file-download` 重建；
- [ ] 配额按会话合计入站 + 出站（200 个 / 100MB）；
- [ ] 提交 / 下载 / 读取 / 搜索 / 写入 / 替换 / 追加 / 列表的错误语义与 `retryable` 正确；
- [ ] 时间线只落元数据，**没有字节**；
- [ ] 会话详情返回 `aiFiles` 树；前端「文件」tab 有「会话文件 / 工作区」两个视图；
- [ ] 工作区树 / 缓存 toggle / 刷新 / 空态；`POST /agent/file/workspace` + `preview` 的 `source='workspace'` 可用；
- [ ] `workspace-files` 工具返回扁平列表（path / bytes / mtime），默认隐藏缓存目录；
- [ ] `workspace-content` 能流式预览图片 / PDF / 视频 / 音频，Office / HTML / SVG 不 inline；
- [ ] 多实例工作区空目录时提示以会话文件为准；
- [ ] `requirements.eta` 有文件纪律：读写只用文件工具，禁止 `bash` 的 `cat` / `sed` / `echo >` / `python` 读写文件；
- [ ] HTML 文件在文件树里**沙箱预览**（CSP + 无 `allow-same-origin`），不是直链 iframe；
- [ ] `html` 围栏的退役与文件预览**同版本切换**（先有文件预览，再摘 prompt / renderer）；
- [ ] 工具卡与历史回看都能显示文件；
- [ ] 删除会话清理工作区 `{root}/{conversationId}`；软删 `ai_files`；**只删 `source='ai'` 对象**，
      入站对象保留；
- [ ] 测试、`typecheck`、`check:ui`、`check:inject`、`check:mastra` 全绿；
- [ ] 设计文档、开发日志、记忆卡片同步。


## 15. 实施记录（2026-11-11）

- `ai_files` 表 + 迁移 `1794394249884-AiFiles` 已落库；`ObjectStorage.putObject` /
  `getDownloadUrl(filename)` 已接入 S3 / COS。
- 后端：`modules/ai/files/{file.service,file.repository,file.schemas,file.tools,path-lock}.ts`；
  9 个工具已注册、授权、进标准测试集。
- 入站：`chat` / `chatStream` 在附件归属校验后 `registerInbound` + `materializeInbound`（best-effort）。
- HTTP：`POST /agent/file/workspace`、`POST /agent/file/preview`（source ai / workspace）、
  `GET /agent/file/workspace-content`（Range / inline / attachment / cookie）。
- 前端：右栏「文件」tab = 会话文件 / 工作区两个视图；HTML 走 `SandboxFrame`；
  工作区图片 / PDF / 视频 / 音频走内容流。
- 提示词：`requirements.eta` 加文件纪律；`html` 围栏 prompt 已退役（组件保留给历史消息，软退役）。
- 测试：server 555 / admin 209 全绿；typecheck / check:ui / check:inject / check:mastra 全绿。
- 已知缺口：`workspace-content` 依赖同站 cookie（跨站 fetch blob 兜底未做）；入站对象引用计数清理未做；
  `workspace-files` 的 `total` 是本次返回数（截断时不是全量）；版本历史 / 老 `.doc` / `.ppt` 预览未做；
  前端直连 OSS 需要桶配置 CORS。
