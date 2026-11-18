# 工作空间（Workspace）：AI 执行环境

> **状态：设计稿（2026-11-18），未实施。**
>
> 本文取代 [workspace-runtime.md](workspace-runtime.md) 里的「工作区 = 会话级目录」模型，
> 以及 [ai-file-manager.md](ai-file-manager.md) 里「`ai_files` 的会话内路径即文件真身」的口径。
> 旧文档保留作为历史论证；实施时以本文为准，落地后旧文档标注「已取代」。
>
> 关联：[capability-gateway.md](capability-gateway.md)（能力登记与路由）、
> [capability-protocol.md](capability-protocol.md)（能力接入协议）、
> [ai-file-manager.md](ai-file-manager.md)（保存下来的文件）、
> [distributed-ai-architecture.md](distributed-ai-architecture.md)（服务拆分与部署形态）。

## 0. 一句话

**工作空间是 AI 执行命令、读写文件的临时环境；会话是过程；环境可销毁重建，只有对象存储里的产物和用户 git 仓库里的代码是持久的。**

产品定位：个人级（不引入组织/团队层），云端部署，多租户。

## 1. 概念模型

```
User ──1:N── Workspace ──1:N── Session
```

| 概念 | 定义 | 生命周期 |
| --- | --- | --- |
| **User** | 账户，唯一权限主体 | 永久 |
| **Workspace** | AI 执行环境：能跑命令、能读写文件的一个隔离运行时 | 创建 → 活跃 → 空闲 → 销毁 |
| **Session** | 一次劳动过程（一轮对话及其实践） | 随会话创建/删除 |

三条不变量：

1. **一个 Session 恒有一个 Workspace**，工具作用域因此没有歧义。
2. **文件与命令必须在同一个 Workspace 内**——这是定义，不是原则。不存在「bash 在容器、file 工具在宿主」。
3. **Workspace 本身不持久化**；它的文件是临时的，环境销毁即消失。

### 1.1 为什么不是「资产」

产品讨论里一度把 Workspace 设计成用户可管理、可归档、可恢复的持久资产。这个方向被否决，原因：

- 用户真正要留下来的东西有两类：**产物**（要下载/分享/预览）和**代码**（要提交到 git）。前者由对象存储承担，后者由用户自己的 git 承担。
- 把环境做成资产，会引出快照、归档、恢复白名单、跨天续用等一整套生命周期，而这些需求的真正解法是 git 和 OSS，不是「把容器留住」。
- 环境是**可重建的**：`git clone` + `pip install -r` 就能复原，不需要把进程状态和磁盘一起保存。

因此：**不存环境快照，不做资产语义。**

### 1.2 与市面对标的关系

业界「Workspace」至少有四层语义，不能混用：

| 层 | 代表 | 与本设计的关系 |
| --- | --- | --- |
| 组织/租户 | LobeHub、Coze、Dify | **不做**：个人级产品，无成员/角色/计费池 |
| 执行环境 | AgentScope、E2B、Daytona | **本设计就是这一层** |
| 项目 | Claude Code Projects、Codex Cloud | 部分借鉴：项目概念由 git 仓库承担 |
| 任务 | Manus | 部分借鉴：按需创建、闲置回收、只恢复重要文件 |

## 2. 执行后端

### 2.1 v1 选型：Docker 容器

| 方案 | 隔离 | 部署门槛 | 结论 |
| --- | --- | --- | --- |
| 裸 Docker | 共享宿主内核 | 低 | **v1 采用，必须加固** |
| gVisor（runsc） | 用户态内核拦截 syscall | 低（普通 Linux 主机即可） | 后备升级项 |
| Firecracker microVM | 独立内核（KVM） | 高（裸金属 / 嵌套虚拟化 / 托管） | 后置 |
| 完整 VM | 独立内核 | 高 | 不做 |

选 Docker 的理由：生态成熟、启动秒级、成本低、团队熟悉。gVisor / microVM 被推迟的原因是部署门槛（gVisor 虽门槛低但排查成本高，microVM 需要 KVM 与裸金属），不是它们不好。

**架构约束：后端必须可替换。** 业务代码只依赖 `WorkspaceRuntime` 接口，不直接依赖 docker。未来切换 gVisor 只是把 `--runtime=runsc` 换上去，镜像与代码不动。

```
type WorkspaceBackend = 'local' | 'container' | 'microvm'
```

- `container`：当前实现为 Docker；未来可换 runsc / Kata。
- `local`：仅用于自托管单租户（`AGENT_WORKSPACE_MODE=off` 的历史口径），云端多租户禁止。
- `microvm`：预留，未实现。

### 2.2 容器加固（云端多租户的硬要求）

缺一条都不得上公网：

1. **绝不 `--privileged`**；不追加 `CAP_SYS_ADMIN` 等额外 capability；**绝不挂载 `docker.sock`**。
2. **不用 `--network host`**；用 bridge + NAT 出网。
3. **根文件系统只读**，工作目录单独给可写层。
4. **默认 seccomp 策略**，不关闭。
5. **资源硬限制**：CPU、内存、pids、磁盘配额——防挖矿、防写满宿主。
6. **user namespace 映射**：容器内可以是 root（AI 需要 `apt-get`），但映射到宿主非特权用户。
7. **屏蔽宿主内网与云 metadata**（`169.254.169.254`）；网络只放公网。

**容器内 root 不是问题，问题是别给它逃逸的能力。**

残余风险（共享内核）靠三样压低：审计、配额限流、分级开放（早期不公开注册）。

### 2.3 旧 L1 沙箱退役

现有 [workspace-runtime.md](workspace-runtime.md) 的 macOS `sandbox-exec` / Linux `bwrap`（L1）在容器方案下**退役**：

- 容器已是隔离边界，容器内再套一层 OS 沙箱没有意义。
- `local` 后端仅保留给自托管单租户，不做云端默认。

## 3. 文件系统与持久化

### 3.1 一个坐标

```
Workspace = { location, runtime }
   location : 文件在哪（真身）
   runtime  : 命令在哪跑
   两者必须指向同一份字节
```

三种后端都满足：

| 后端 | 文件真身 | 命令在哪 |
| --- | --- | --- |
| local | 宿主某目录 | 宿主（自托管） |
| container | 容器可写层（不挂卷） | 容器内 |
| microvm | VM 磁盘 | VM 内 |

**container 不挂宿主卷**：环境自包含，容器可写层就是文件系统。挂临时卷可以省掉 file 工具改造，但与「环境自包含」的定位相悖，v1 不用。

### 3.2 文件访问通道

`file-*` 工具与 `bash` 共享同一个环境文件系统，但走不同通道：

- `bash` → 容器 exec（命令直接在环境内跑）。
- `file-*` → **v1 直接用 `docker exec` 在容器内执行**：一次调用一次 exec；`file-list` / `workspace-files` 用容器内 `find`，`file-search` 用容器内 `grep`，遍历留在环境内、不逐文件传回。
  - 不预置常驻文件服务：少一个进程、少一种协议、少一处鉴权，v1 够用。
  - 若 file 调用成为性能瓶颈，再引入常驻服务（HTTP / Unix socket），届时只换实现、不动调用方。

### 3.3 持久化的两端

对象存储（OSS）是环境的**入口和出口**，不是工作空间的存储：

- **入口**：用户上传的附件进 OSS，会话开始时导入环境。
- **出口**：AI 显式保存的产物进 OSS，用户可下载 / 预览 / 分享。
- 环境销毁后，未保存的工作区文件随之消失——这是预期行为，不是缺陷。

代码的持久化归用户自己的 git：环境里跑 `git clone` / `git push`，环境销毁后靠 clone 重建。

**git 凭据（已定）**：容器启动时生成 SSH 密钥对；**公钥展示给用户，由用户自行添加到远端**；私钥只留在环境内，不落库、不回显、不跨环境复用。环境销毁后密钥失效，重建需重新添加公钥。不注入 PAT，平台不代管用户凭据。

### 3.4 `ai_files` 降级

现有 `ai_files`（`packages/db/src/entities/ai-file-entity.ts`）混了两种东西：会话内临时文件 与 已保存产物。新模型下：

- `ai_files` **只记录「保存的文件」**（OSS 里的对象），按 `workspace_id` 归属，不再以 `conversation_id` 为主键维度。
- 工作区内的临时文件**不入库**；文件列表由环境内文件服务实时返回。
- 若需要列表/搜索加速，引入可重建的索引，索引不是事实来源。

## 4. 能力服务如何作用到 WorkSpace

### 4.1 按「是否需要工作空间」分组

现有 17 个能力分两类，**不是全部塞进容器**：

| 能力 | 需要 Workspace？ | 执行位置 | 通道 |
| --- | --- | --- | --- |
| `bash` | 是 | 环境内 | exec |
| `file-*`（9 个） | 是 | 环境内 | fs |
| `web-*`（3 个） | 否 | 平台侧 | 宿主直连 |
| `memory-*`（3 个） | 否 | 平台侧 | PG |
| `read-tool-result` | 否 | 平台侧 | Redis/PG |

原则：需要访问用户文件的进环境；需要访问平台网络/数据库的留平台侧。这既是安全边界，也避免容器内跑一套完整服务。

### 4.2 能力声明新增执行位置

`@CapabilityDecl` 在现有 `risk` / `input` 之外增加：

```ts
execution: { where: 'host' | 'workspace' }
```

- `host`：平台侧执行，无额外上下文。
- `workspace`：需要 `workspaceId`，经 `WorkspaceRuntime` 转发。

网关/编排层按字段路由，不按能力名硬编码。现有 `request.workspaceConversationId` 由 `request.workspaceId` 取代。

### 4.3 懒创建与唤醒

能力调用时环境可能未创建或已销毁：

```
invoke(bash, workspaceId)
  → 不存在？创建
  → 空闲？唤醒
  → 执行
  → 刷新 last_used_at（续命）
```

与生命周期共用同一套机制，不重复实现。

## 5. MCP

### 5.1 定性

MCP 是**能力接入协议**，与内置 code 能力并列，归能力目录/网关管理；**不是工作空间的一部分**。
`protocol: 'capability' | 'mcp'` 已在契约中，MCP 适配器（`initialize` / `tools/list` / `tools/call`）**已实现**（HTTP 型）；
stdio 不做。

### 5.2 来源与位置

| 类型 | 例子 | MCP server 位置 | 凭据 |
| --- | --- | --- | --- |
| 平台托管 | 高德 / DeepWiki / 团队自建的远程 MCP | 平台侧 | 平台凭据（服务一份） |
| 环境内（按需） | 只能从环境网络访问的 MCP | 容器内 | 平台注入的临时凭据 |

- 默认走**平台侧**：不为每个容器装 MCP 进程；
- 只有「只能从环境网络访问」时才下沉到容器，凭据临时注入、用完即删；
- **不做用户自带 MCP（BYO）**：MCP 由管理员登记，平台一份凭据，通过服务级授权决定谁能用。

### 5.3 与能力的统一

MCP 能力与 code 能力走同一个 `where` 路由：

```
能力 = { protocol: capability | mcp, where: host | workspace, connection }
```

工作空间只提供 exec / fs 两个原语，不关心调用方是内置能力还是 MCP。

### 5.4 凭据与授权

- **凭据属于平台**：一个服务一份，加密存储、接口不回显，只由网关在调用时注入；
- **授权按服务**：`source='manual'`（外部服务 / MCP）需要 `ai_service_grants` 允许；
  `source='code'`（自建协议服务，如 `common`）默认全部可用，不参与授权；
- 授权是**管理员 × 服务**的允许列表，任何管理员都能配置；页面在「服务授权」，设计见
  [service-authorization.md](service-authorization.md)；
- 工作区**不保存 MCP 凭据、不感知授权**；它只按 `where` 决定在哪执行。

> 用户级凭据、`credentialScope: user/shared`、用户自带 MCP、跨用户隔离**暂不做**；
> 相关论证见 [resource-isolation.md](resource-isolation.md)（暂缓）。

### 5.5 安全

MCP 一旦交给模型，模型就能执行 SQL/命令。**权限边界（只读、库白名单、表白名单）必须在接入时定死**，不能交给模型自述。平台侧 MCP 默认只读。

## 6. 网络与安全

### 6.1 网络策略：全通

**不做网络禁用**。用户与 AI 都能正常访问公网（装依赖、`git clone/push`、调用外部 API）。

前提是 2.2 的加固：bridge 网络、屏蔽内网与 metadata、资源限制。**单独给网络而不给隔离，等于把服务器交出去。**

### 6.2 不做审批，做风险提示

审批（human-in-the-loop）不作为默认安全手段，原因：

- 用户看不懂命令（`curl | bash`、混淆脚本），确认没有判断价值。
- 确认疲劳：任务里几十条命令，用户会无脑同意。
- 提示注入：恶意命令可以伪装成正常操作。

安全兜底是：**容器隔离 + 资源限制 + 审计**。风险提示只做「告知」。

### 6.3 风险提示规则

判定必须确定性，**不依赖模型自评**（模型可被注入）：

1. **能力级**：沿用声明里的 `risk: 'read' | 'write'`。
2. **命令级**（仅 bash）：规则匹配——删目录、管道执行远端脚本、改系统路径、提权、访问凭据、数据外传、强制推送。

| 级别 | 判定 | 展示 |
| --- | --- | --- |
| 低 | 读操作 | 不提示 |
| 中 | 写工作区 | 卡片标注「写入」 |
| 高 | 命中命令规则 | 红色「高风险」+ 一句话原因 |

**时机**：命令开始执行时标注，不暂停、不等待确认。

### 6.4 审计

每条命令、每次能力调用落库（现有 `ai_tool_audit` 链路可沿用）。网络不拦，但要知道发生过什么——这是审批撤销后唯一的追踪手段。

## 7. 生命周期

```
创建 → active ──(闲置)──→ idle ──(过期)──→ destroyed
         ↑                    │
         └────(下一个会话)─────┘
```

- **创建**：会话首次需要执行环境时自动创建（用户不必显式操作）；也可由用户显式创建多个。
- **idle**：最后一个会话结束后进入空闲，保留 **2 小时**，期间回来直接续用。保留期的作用是「防打断」，不是「防丢数据」。
- **destroyed**：过期即销毁，容器与可写层一并删除。产物在 OSS，代码在 git。
- **不做**：环境快照、归档、恢复白名单。
- **删除会话不删除环境**；只有环境过期或用户显式销毁才删。

**用户可管理的**：查看有哪些环境、启动/停止、销毁。没有重命名、归档、长期保留。

## 8. 并发

同一 Workspace 绑定多个 Session 时必须定义并发语义：

- **读**：并行。
- **文件写**：按 `workspaceId:path` 互斥（现有 `PathLock` 改锁键即可），避免两个会话同时写同一路径互相覆盖。
- **bash**：按 Workspace **串行**——命令会写什么由模型决定，无法预判，只能整个串行。
- **资源配额**：个人总配额（CPU/内存/磁盘/并发）封顶；单 Workspace 再设上限。

## 9. 镜像

### 9.1 基础镜像

推荐 **Debian slim**（glibc 生态好），而不是 Alpine（musl 会让 `pip`/`node-gyp` 装包踩坑）。基础镜像只放「能装」的最小集：

- `bash`、`coreutils`、`find`、`grep`、`sed`、`awk`、`tar`、`curl`、`wget`、`ca-certificates`
- `git`
- `python3` + `pip`、`node` + `npm`
- 容器内文件服务（fs 代理）

其余工具由 AI 在环境里按需安装（`apt-get` / `pip` / `npm`）。**镜像目标不是「预装齐全」，是「让 AI 装得动」。**

### 9.2 模板

| 镜像 | 内容 | 面向 |
| --- | --- | --- |
| `base` | 最小集 | 通用、脚本、文件处理 |
| `python-data` | base + pandas/numpy/matplotlib | 数据分析 |
| `node-web` | base + 常见前端工具 | 网页/前端 |

v1 只提供平台预置模板，**不支持用户自定义镜像**；镜像作为 Workspace 属性（`image`），记录**具体 tag**，不用 `latest`。

分发：v1 不做 P2P / 预热流水线，节点提前拉好这三个镜像即可；规模上来再考虑镜像预热与分发加速。

### 9.3 提示词

系统提示词/环境说明必须写清楚：当前是 Debian、包管理用 `apt-get`、Python 用 `pip3`、Node 用 `npm`。否则模型会试 `yum` / `apk` / `brew`，浪费轮次。

### 9.4 依赖不持久

容器销毁后安装的依赖消失。依赖应由 `requirements.txt` / `package.json` 声明，重建时重新安装。这是「不持久化」的合理边界：**依赖不是资产，声明才是。**

## 10. 数据模型

```sql
-- 工作空间（执行环境）：只记配置与状态，不记文件
ai_workspaces
  id            varchar(20)  PK
  user_id       varchar(20)  NOT NULL
  name          varchar(64)  NOT NULL
  backend       varchar(16)  NOT NULL  -- local | container | microvm
  image         varchar(64)            -- container 时必填
  location      jsonb                  -- backend 相关（root / container 配置 / host）
  file_access   varchar(16)  NOT NULL  -- read-only | write
  status        varchar(16)  NOT NULL  -- active | idle | destroyed
  created_at    timestamptz
  last_used_at  timestamptz

-- 会话挂载到工作空间（1:N）
conversations
  + workspace_id varchar(20)           -- 可空过渡，迁移期回填

-- 已保存的文件（OSS 对象）：不再是工作区临时文件
ai_files
  workspace_id  varchar(20)  NOT NULL  -- 取代 conversation_id 的归属维度
  path, filename, key, media_type, bytes, sha256, source, user_id, run_id, tool_call_id
```

说明：

- `location` 用 jsonb：不同 backend 字段不同，不为三种后端各建一套列。
- `file_access` 在 Workspace 级：权限是场所的属性，不是某次会话的属性。
- `conversations.workspace_id` 可空只是迁移期；稳定后应 NOT NULL。

## 11. 迁移路径

从现状（会话即目录 + L1 沙箱 + `ai_files` 即真身）迁移：

1. **建表**：`ai_workspaces` + `conversations.workspace_id`（可空）+ `ai_files.workspace_id`（可空）。
2. **回填**：每个会话建一个默认 workspace，按 `{root}/{conversationId}` 生成 `location`；`ai_files` 按会话归属回填 `workspace_id`。
3. **改清理逻辑**（第一优先级）：`cleanupConversation` 现在会 `rm` 整个工作区目录——必须改成「删会话只解绑」，只有销毁 workspace 才清目录。
4. **抽 `WorkspaceRuntime` 端口**：`exec` + `fs` 锚定 `location`；`local` 实现 = 现有逻辑搬家，行为不变。
5. **灰度切容器**：新会话创建容器环境，旧会话保留 local；`WorkspaceRuntime` 按 backend 分发。
6. **`ai_files` 收敛**：只保留「保存的文件」，工作区临时文件改为实时查询。
7. **删 L1 沙箱**：`local` 仅自托管保留。

## 12. 验收用例

| # | 场景 | 期望 |
| --- | --- | --- |
| E1 | 新用户首次开会话 | 自动创建 workspace，`base` 镜像，无感知 |
| E2 | 同一 workspace 开两个会话 | 共享文件系统；写互斥；bash 串行 |
| E3 | 会话结束 2 小时后再回来 | 环境已销毁；产物在 OSS；代码靠 git 重建 |
| E4 | 容器内 `apt-get install` | 成功；网络全通；命令计入审计 |
| E5 | `curl https://x.sh \| bash` | 执行成功，但标记「高风险」 |
| E6 | 两个会话同时写同一路径 | 后写者等待锁，不覆盖 |
| E7 | 用户删除会话 | workspace 保留；不删目录 |
| E8 | 平台侧 MCP 连 MySQL | 只读；凭据不回显；审计落库 |
| E9 | 容器尝试访问 `169.254.169.254` | 拒绝 |
| E10 | `local` 后端在云端多租户 | 配置拒绝，进程不启动 |

## 13. 决策记录

| # | 问题 | 结论 |
| --- | --- | --- |
| D1 | git 凭据如何进容器 | **已定**：容器启动生成 SSH 密钥对，公钥交用户自行配置，私钥不外泄、平台不代管（§3.3） |
| D2 | 环境空闲保留期 | **已定**：2 小时 |
| D3 | MCP 适配器实现（invoke 路由、工具清单同步） | **进行中** |
| D4 | file 工具访问容器文件的方式 | **已定（v1）**：`docker exec` 直接执行，不预置常驻文件服务（§3.2） |
| D5 | 镜像构建与分发 | **已定（v1）**：节点预拉三个模板镜像，不做 P2P / 预热流水线（§9.2） |
| D6 | 自定义镜像 | **已定**：不开放 |
| D7 | 风险提示规则的初始清单 | **已定**：见 §13.1 |
| D8 | MCP 凭据模式 | **已定**：`user`（每人一份）与 `shared`（服务一份 + 授权）并存，见 §5.4 |
| D9 | MCP 工具风险分级 | 待补：`McpToolSchema` 加 `risk`，外部工具默认 `write` |

### 13.1 风险提示初始规则（命令级）

| 规则 | 级别 | 说明 |
| --- | --- | --- |
| `rm -rf` / `rm -fr` | 高 | 删除目录 |
| `curl … \| sh` / `wget … \| bash` | 高 | 管道执行远端脚本 |
| `chmod 777` / `chown` | 高 | 权限变更 |
| `sudo` / `su` | 高 | 提权 |
| 写 `/etc` `/usr` `/bin` `/sbin` | 高 | 系统路径 |
| `git push --force` / `git reset --hard` | 高 | 不可逆操作 |
| 读 `~/.ssh` / `~/.aws` / `.env` / `env` | 高 | 凭据暴露面 |
| `curl -d @…` / `nc` / `scp` / `rsync` 到外部 | 高 | 数据外传 |
| `apt-get install` / `pip install` / `npm install` | 中 | 安装依赖 |
| 其它 bash | 中 | 默认写操作 |
| 读类能力（`read-file` / `file-list` / `web-search`） | 低 | 不提示 |

规则可配置、可扩展；命中即标注，不阻断执行。
