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
- `local`：仅用于自托管单租户（`AGENT_WORKSPACE_SANDBOX=false` 的历史口径），云端多租户禁止。
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

### 2.3 L1 沙箱：容器后端不需要，local 后端保留

现有 [workspace-runtime.md](workspace-runtime.md) 的 macOS `sandbox-exec` / Linux `bwrap`（L1）**不退役**，按后端区分：

- **container / microvm 后端**：容器/VM 已是隔离边界，容器内再套一层 OS 沙箱没有意义——这条路径不用 L1。
- **local 后端**：命令直接跑在宿主进程与工作区目录上，没有容器边界，**必须保留 L1 沙箱**（默认 `enforce` + fail closed），否则等于裸奔。
- `local` 仍然只留给自托管单租户，不做云端默认；它的安全模型要写清楚：**L1 沙箱 + 目录边界，不是容器**。

`WorkspaceRuntime` 的 `local` 实现复用现有 `WorkspaceRuntimeService` 的沙箱逻辑，**不要删**。

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

#### 3.1.1 工作区目录（local 后端）

local 后端的工作区就是**宿主机上的一个目录**，没有第二种目录。差别只有「配没配 `location.root`」：

| | 没配（默认） | 配了 |
| --- | --- | --- |
| 目录 | `<WORKSPACE_LOCAL_ROOT>/<workspaceId>`，默认 `~/.billy/workspaces/<id>`（不存在就建） | 用户给的绝对路径（`realpath` 后），必须**已存在且是目录** |
| 初始化 | 跑：装 CLI / 物化 `.agents/` / 写 `.billy/` / 落凭据 | **不跑**：这些都会写进用户自己的项目，污染仓库 |
| 校验 | 无 | 必须落在 `WORKSPACE_LOCAL_ALLOWED_ROOTS` 内、且不覆盖凭据 denylist；`AGENT_WORKSPACE_SANDBOX` 必须 `enforce` |

> 已知不一致：`WORKSPACE_LOCAL_ROOT` 的代码兜底目前仍是系统临时目录（`<tmpdir>/billy-workspaces`），
> 与默认目录 `~/.billy/workspaces` 的约定不符，待统一；现状与待办见
> [workspace-local-followups.md](workspace-local-followups.md)。

代价与边界：

- **文件能力不经沙箱**：`local` 的 `file-*` 直接以服务进程身份读写（只做「路径必须工作区内」），
  所以「允许根」是唯一的范围限制，不能让它退化成「任意路径」；默认关闭（不配允许根就拒绝）。
- **bash 靠 L1 沙箱**：沙箱仍允许读全盘（除凭据 denylist）、只允许写工作区与缓存，
  所以「配一个 `/Users/you` 这种过宽目录」会被凭据目录检查挡掉（`.ssh` / `.aws` 等在里面）。
- **不提供 `location.setup` 开关**：配了目录后要不要装 CLI / 落凭据，现有需求没有；真需要时按
  「另起一个清单类型」设计，不在 v1 偷加。
- **容器后端不参与**：要「容器 + 宿主目录」得先解挂载带来的逃逸面（见 §2.2），那是另一个方案。

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

### 4.2 能力声明新增执行位置（已实现）

`@CapabilityDecl` 的 `execution` 增加：

```ts
execution: { where: 'host' | 'workspace' }
```

- `host`：平台侧执行（web / memory / read-tool-result / file-submit / file-download）；
- `workspace`：由 **workspace-service 自己登记**（`service: 'workspace'`），网关按扁平 key 直接路由；
  调用方带 `workspaceId`（`request.workspaceId`），执行面不再必须按会话反查。

落地细节：

- `capability-gateway` 的路由仍然只按 **key → 服务**，`where` 不参与网关路由——它决定**谁登记**这个能力；
- common-capability 的 manifest 过滤 `where === 'workspace'` 的能力，避免跨服务重名 409；
- workspace-service 登记：`bash`（task 形态）+ `file-list` / `read-file` / `write-file` /
  `append-file` / `replace-file` / `workspace-files` / `file-search`（sync）；
- **OSS 语义留在平台侧**：`file-submit` / `file-download` 仍在 common-capability；
- `request.workspaceId` 已贯通：runtime 信封 → 网关调用 → workspace-service（缺省时回落按会话查）。

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

### 4.4 file 能力的接缝

`FileService` 现在直接调 `node:fs` 操作 `{workspaceRoot}/{conversationId}` 的本地目录。迁移分两步：

1. **已完成**：`FileContext.workspaceId` + `WorkspaceFsPort`（`packages/ai-data/src/file/workspace-fs.port.ts`）；
   file 执行器按会话解析工作区（`WorkspaceLocator`），不再假设本地根。
2. **已完成**：`FileService` 的 `node:fs` 原语（stat / read / write / append / readdir / rm）
   已换成 `WorkspaceFsPort`；common-capability 注入「调 workspace-service」的实现，本地实现保留给自托管。
3. **另**：fs 类文件能力已迁到 workspace-service 执行（见 §4.2），common 只留 OSS 类。

边界：

- `file-submit` / `file-download` 的 OSS 语义留在平台侧（元数据与对象存储不迁到执行面），
  但读写工作区文件走 port；
- 分页、噪音目录、软链校验等**业务**留在 `FileService`，port 只做原语，换实现时模型面行为不变。

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

## 7. 生命周期与职责

### 7.1 谁写什么

| 数据 | 写方 | 存哪 |
| --- | --- | --- |
| 配置（name / image / backend / file_access / is_default） | **main** | `ai_workspaces` |
| 期望状态（running / stopped，用户意图） | **main** | `ai_workspaces.desired_status` |
| 实际运行态（容器是否活着、containerId、lastUsedAt） | **workspace-service** | 内存 + 容器标签 + Redis 锁 / lastUsed（多副本），**不落 DB** |

- **main 是控制面**：列表、创建、改名、删除、启停，只写表。
- **workspace-service 是执行面**：建 / 停 / 销毁容器、exec、fs；**不写 `ai_workspaces`**。
- 列表 = 表里的配置 + 向 workspace-service 查一次运行态；查不到就显示「未启动 / 不可用」。
- 容器带 `workspace-id` 标签，workspace-service 重启 / 换副本后按容器名认领，不依赖 DB 恢复。

### 7.2 状态流转

```
desired_status: stopped ──用户启动 / 首次执行──→ running
                running ──用户停止────────────→ stopped
                running ──2h idle 回收────────→ （实际停止，desired 不变）
```

- **默认工作区**：主体（当前是 admin）创建时由 main 写一条记录（`is_default = true`、`desired_status = stopped`、统一镜像的当前版本），**不启动容器**；会话默认落在这里，用户不必先建工作区。侧边栏把它作为兜底分组展示。
- **懒启动**：会话首次需要执行时 `ensure` 拉起容器；也可由用户显式点「启动」。
- **2 小时 idle 回收**：workspace-service 定时器停止并释放容器。这是**实际状态变化**，不回写 DB——`desired_status` 仍是 `running`，用户下次执行时 `ensure` 重新拉起。
- **用户手动停止**：main 写 `desired_status = stopped`；此后不自动拉起，必须用户点「启动」。
- **销毁**：用户删除工作区 → main 软删记录 → 调 workspace-service `destroy`。
- **不做**：环境快照、归档、恢复白名单。
- **删除会话不删除环境**；只有环境过期或用户显式销毁才删。

**用户可管理的**：查看有哪些环境、启动/停止、销毁。重命名、归档、长期保留暂不做。

### 7.3 多副本（2026-11-22 落地）

- **只支持 kubernetes 后端**：任意 Pod 都能 `kubectl exec` 工作区 Pod；Docker 容器在宿主本地，
  跨宿主副本 exec 不到，local 后端是 Pod 本地盘，二者启动自检直接拒绝多副本。
- 开发 / 单机验证可以用**同宿主 Docker 多副本**：`WORKSPACE_ALLOW_SHARED_DOCKER=true`，所有副本必须共享同一个 Docker daemon；跨宿主 Docker 仍不支持。
- 运行态仍是「内存 + 容器标签」，但**跨副本的 lifecycle / exec / fs 锁和 lastUsed 放 Redis**；
  `handles` 只是本地缓存，exec / fs 前会探测容器是否还活着，失效就重建。
- 回收器每个副本都扫 DB 列表，但先抢 lifecycle、再抢 exec；抢不到就跳过。不做全量认领。
- 每个 Pod 上报自己的 `WORKSPACE_INSTANCE_ID` / `WORKSPACE_SERVICE_ENDPOINT`（POD_NAME / POD_IP），
  网关 / tasks/get 才能回到原实例。
- **发布顺序**：先从 1 副本换成**支持 Redis 锁的新版本**（`WORKSPACE_MULTI_INSTANCE=false` 也可），
  等全部 Pod 都是新版本后再开 `WORKSPACE_MULTI_INSTANCE=true` 并扩到 2 副本。旧版没有 Redis 锁，
  新旧混跑时滚动更新仍会双写。
- **不在本期**：正在跑的 bash 跨 Pod 存活（Pod 死任务 expired，用户重试）；task 持久化；
  Docker 多宿主。

## 8. 并发

同一 Workspace 绑定多个 Session 时必须定义并发语义：

- **读**：并行。
- **文件写**：按 `workspaceId:path` 互斥（现有 `PathLock` 改锁键即可），避免两个会话同时写同一路径互相覆盖。
- **bash**：按 Workspace **串行**——命令会写什么由模型决定，无法预判，只能整个串行。
- **资源配额**：个人总配额（CPU/内存/磁盘/并发）封顶；单 Workspace 再设上限。

> **已实现（2026-11-22）**：单副本走 `KeyedMutex`，多副本走 `RedisLockService`（`workspace-coordinator.ts`）——
> `lifecycle` 锁管 ensure / setup / stop / destroy / reap，`exec` 锁按工作区串行，`fs` 写按
> `workspaceId:path` 串行；写（`write` / `replace` / `write-bytes`）走「同目录 tmp + `rename`」原子落盘，
> 读不再可能读到半截文件。配额仍未做；Pod 中途死亡时旧命令可能继续，语义是 at-least-once。

## 9. 镜像

### 9.1 基础镜像

推荐 **Debian slim**（glibc 生态好），而不是 Alpine（musl 会让 `pip`/`node-gyp` 装包踩坑）。基础镜像只放「能装」的最小集：

- `bash`、`coreutils`、`find`、`grep`、`sed`、`awk`、`tar`、`curl`、`wget`、`ca-certificates`
- `git`
- `python3` + `pip`、`node` + `npm`
- 容器内文件服务（fs 代理）

其余工具由 AI 在环境里按需安装（`apt-get` / `pip` / `npm`）。**镜像目标不是「预装齐全」，是「让 AI 装得动」。**

### 9.2 只有一个镜像，按版本发布

v1 **不做多模板**：全平台一个基础镜像（`billy-workspace`），通过**版本 tag** 区分：

| 项 | 口径 |
| --- | --- |
| 镜像 | `billy-workspace`（Debian slim + 9.1 的最小集） |
| 版本 | 具体 tag（如 `2026.11.0`），**不用 `latest`** |
| 记录 | `ai_workspaces.image` 存完整引用 `billy-workspace:<tag>` |
| 升级 | 新 tag 发布后，旧 workspace 保持原 tag，直到销毁重建；**不做原地升级** |
| 自定义 | **不开放**用户自定义镜像 |
| 分发 | 节点预拉当前版本；不做 P2P / 预热流水线 |

不分模板的原因：AI 能自己装（9.1），多模板只会让镜像维护和冷启动变复杂；统一镜像 + 版本，已经能表达「今天的环境和明天的环境不一样」。

构建：

```bash
docker build -f docker/Dockerfile.workspace-image -t billy-workspace:<tag> docker
```

> 注意区分两个镜像：`docker/Dockerfile.workspace-image` 是**被管的工作区容器**（shell / 语言运行时 / git），
> `docker/Dockerfile.workspace-service` 是**执行面服务**（9995，管容器生命周期）。

常驻：`WORKSPACE_IDLE_TIMEOUT_MS=0` 时回收器跳过，容器一直活着，直到用户手动停止 / 删除；默认 2 小时。

### 9.3 提示词

系统提示词/环境说明必须写清楚：当前是 Debian、包管理用 `apt-get`、Python 用 `pip3`、Node 用 `npm`。否则模型会试 `yum` / `apk` / `brew`，浪费轮次。

### 9.4 依赖不持久

容器销毁后安装的依赖消失。依赖应由 `requirements.txt` / `package.json` 声明，重建时重新安装。这是「不持久化」的合理边界：**依赖不是资产，声明才是。**

## 10. 数据模型

```sql
-- 工作空间（执行环境）：只记配置与状态，不记文件
ai_workspaces
  id            varchar(20)  PK
  owner_type    varchar(8)   NOT NULL  -- admin | user（当前只有 admin 用 AI 会话）
  owner_id      varchar(20)  NOT NULL
  name          varchar(64)  NOT NULL
  is_default    boolean      NOT NULL DEFAULT false  -- 每个主体恰好一条
  backend       varchar(16)  NOT NULL  -- local | container | microvm
  image         varchar(64)            -- container 时必填
  location      jsonb                  -- backend 相关（root / container 配置 / host）
  file_access   varchar(16)  NOT NULL  -- read-only | write
  desired_status varchar(16) NOT NULL DEFAULT 'stopped'  -- running | stopped（用户意图；实际运行态不落库）
  created_at    timestamptz
  last_used_at  timestamptz

-- 默认工作区唯一：同一主体只能有一条默认
CREATE UNIQUE INDEX uk_workspace_default
  ON ai_workspaces (owner_type, owner_id)
  WHERE is_default = true AND deleted_at IS NULL;

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
- `owner_type + owner_id` 而不是 `user_id`：当前只有 admin 用 AI 会话，但将来用户端开放时同一张表可复用；不把 `admins.id` 与 `users.id` 混进同一列。
- `desired_status` 只表达**用户意图**；容器是否真的在跑由 workspace-service 实时返回，不落库（避免双写）。

## 11. 迁移路径

从现状（会话即目录 + L1 沙箱 + `ai_files` 即真身）迁移：

1. **建表**：`ai_workspaces` + `conversations.workspace_id`（可空）+ `ai_files.workspace_id`（可空）。
2. **存量主体回填默认工作区**：每个存量 `admin` 建一条 `is_default = true` 的空工作区（统一镜像的当前版本、`desired_status = stopped`），与 `AdminService.create()` 的初始化同一套逻辑。
3. **存量会话回填**：每个存量会话建一条**非默认** workspace（`name` 取会话标题，`location.root = {root}/{conversationId}`），`conversations.workspace_id` 指向它——保留原目录隔离与数据；`ai_files` 按会话归属回填 `workspace_id`。
4. **改清理逻辑**（第一优先级）：`cleanupConversation` 现在会 `rm` 整个工作区目录——必须改成「删会话只解绑」，只有销毁 workspace 才清目录。
5. **抽 `WorkspaceRuntime` 端口**：`exec` + `fs` 锚定 `location`；`local` 实现 = 现有逻辑搬家，行为不变。
6. **灰度切容器**：新会话创建容器环境，旧会话保留 local；`WorkspaceRuntime` 按 backend 分发。
7. **`ai_files` 收敛**：只保留「保存的文件」，工作区临时文件改为实时查询。
8. **删 L1 沙箱**：`local` 仅自托管保留。

## 12. 验收用例

| # | 场景 | 期望 |
| --- | --- | --- |
| E1 | 新用户首次开会话 | 自动创建 workspace（统一镜像），无感知 |
| E2 | 同一 workspace 开两个会话 | 共享文件系统；写互斥；bash 串行 |
| E3 | 会话结束 2 小时后再回来 | 环境已销毁；产物在 OSS；代码靠 git 重建 |
| E4 | 容器内 `apt-get install` | 成功；网络全通；命令计入审计 |
| E5 | `curl https://x.sh \| bash` | 执行成功，但标记「高风险」 |
| E6 | 两个会话同时写同一路径 | 后写者等待锁，不覆盖 |
| E7 | 用户删除会话 | workspace 保留；不删目录 |
| E8 | 平台侧 MCP 连 MySQL | 只读；凭据不回显；审计落库 |
| E9 | 容器尝试访问 `169.254.169.254` | 拒绝 |
| E10 | `local` 后端在云端多租户 | 配置拒绝，进程不启动 |
| E11 | 新建 admin | 立刻有一条默认工作区（`stopped`、当前镜像版本）；首条执行消息时容器才拉起 |
| E12 | 重复执行 `seed:admin` | 不产生第二条默认工作区（幂等） |

## 13. 决策记录

| # | 问题 | 结论 |
| --- | --- | --- |
| D1 | git 凭据如何进容器 | **已定**：容器启动生成 SSH 密钥对，公钥交用户自行配置，私钥不外泄、平台不代管（§3.3） |
| D2 | 环境空闲保留期 | **已定**：2 小时 |
| D3 | MCP 适配器实现（invoke 路由、工具清单同步） | **进行中** |
| D4 | file 工具访问容器文件的方式 | **已定（v1）**：`docker exec` 直接执行，不预置常驻文件服务（§3.2） |
| D5 | 镜像构建与分发 | **已定（v1）**：单一镜像按版本发布，节点预拉当前版本，不做 P2P / 预热流水线（§9.2） |
| D6 | 自定义镜像 | **已定**：不开放 |
| D7 | 风险提示规则的初始清单 | **已定**：见 §13.1 |
| D8 | MCP 凭据模式 | **已定**：`user`（每人一份）与 `shared`（服务一份 + 授权）并存，见 §5.4 |
| D9 | MCP 工具风险分级 | 待补：`McpToolSchema` 加 `risk`，外部工具默认 `write` |
| D10 | 默认工作区初始化 | **已定**：主体（当前 admin）创建时建一条 `is_default` 记录（`stopped`、当前镜像版本），容器懒启动；挂钩 `AdminService.create()`，`seed:admin` 自动覆盖；存量由迁移回填 |
| D11 | 服务职责划分 | **已定（方案 B）**：main 管 CRUD / 配置 / `desired_status`；workspace-service 只执行、不写表；运行态不落 DB（容器标签 + 内存；多副本时锁 / lastUsed 落 Redis）；2h 回收由 workspace-service 定时器做，不回写 `desired_status` |

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
