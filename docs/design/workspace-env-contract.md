# 工作区执行环境：驱动抽象（第一版）

> 状态：**草案（2026-11-22）**。范围只覆盖 `local` 与 `docker` 两种环境；`kubernetes`（Pod）
> 明确**暂不纳入**本次抽象，代码现状保留不动，等这版落地后再议。
>
> 关联：[workspace.md](workspace.md)（概念模型与取舍）、
> [workspace-local-followups.md](workspace-local-followups.md)（现状与待办清单）、
> [../guide/backend.md](../guide/backend.md)（部署与接口）。

## 1. 要解决什么

现在工作区的 11 个能力（`bash` + 7 个文件能力 + 3 个凭据能力）全部注册在 workspace-service，
但它们的实现是「能力 → 运行时 → 到处 if 后端」：运行时里 `backend === 'local' / 'container'`
的分支有 9 处，文件操作写了两套（local 用 Node fs，容器把每个 op 翻译成 shell 命令），
初始化与凭据又默认「有 POSIX shell、能写 HOME、能全局装包」。

结果就是每加一种环境（Windows 本机、microVM、远端主机）都要在三个地方分别改：
文件实现、初始化脚本、环境变量注入。目标是**新增一种环境 = 写一个驱动 + 一张声明**。

## 2. 四层分工

| 层 | 放什么 | 例子 | 不该放 |
| --- | --- | --- | --- |
| **能力（工具）** | 入参校验、语义、返回形状、风险声明、错误翻译 | `bash` 收命令并映射退出码；`write-file` 校验路径与内容 | 任何「本机还是容器」的判断 |
| **执行面（workspace-service）** | 解析工作区 → 选驱动 → 加锁、超时、输出上限、回收、凭据补偿、初始化编排 | 同一工作区命令排队；空闲 2 小时回收 | 某个环境的专属细节 |
| **驱动（环境实现）** | 原语：探测、准备、执行、文件、释放；能力声明 | Docker 驱动把「写文件」翻译成临时文件 + `mv`；Host 驱动用 Node fs | 工具参数、能力登记、业务语义 |
| **策略** | 按声明分流的业务规则 | 初始化装包/只检查/跳过；凭据落盘或走 env；`stop` 文案 | 原语实现 |

依赖方向：能力 → 执行面 → 驱动，驱动不认识工具。

## 3. 接口草案

```ts
/** 平台画像：工具描述、入参校验、错误文案都按它生成 */
interface EnvFeatures {
  /** 整条命令由谁解释：sh = /bin/sh；cmd = Windows cmd.exe */
  shell: 'sh' | 'cmd'
  /** 隔离档位：os = 系统沙箱；none = 只能靠专用低权限用户 + 目录权限 */
  sandbox: 'os' | 'none'
  /** 命令默认能不能出网（沙箱断网 / 容器 bridge / 容器 none） */
  network: 'deny' | 'allow' | 'configurable'
  /** 能不能往用户 HOME 写文件（决定凭据落地方式） */
  writeHome: boolean
  /** 能不能装全局包（决定安装清单是「装」还是「只检查」） */
  installGlobal: boolean
  /** 停止后数据还在不在（决定文案与「重建」预期） */
  persistence: 'durable' | 'ephemeral'
  /** 有没有内存 / CPU / 进程数限额（没有则由执行面兜底） */
  resourceLimits: boolean
  /** 能否给工作区外的只读目录（技能目录） */
  extraReadRoots: boolean
  /** 是否支持多副本 */
  multiInstance: boolean
}

/** 工作区坐标：id + 根 + 驱动私有句柄（容器名等，只有驱动自己认识） */
interface WorkspaceRef {
  workspaceId: string
  /** 工作区根：Host = 宿主路径；Docker = 固定 /workspace */
  root: string
  /** 驱动私有数据（如容器名），外层只透传，不解释 */
  handle?: Record<string, string>
  /** 根是否由平台托管（false = 用户指定的目录，跳过初始化写入） */
  managed: boolean
}

interface ExecRequest {
  command: string
  cwd?: string                // 相对工作区根
  env?: Record<string, string> // 由驱动翻译成 spawn env / shell 前缀 / set
  stdin?: string
  timeoutMs?: number
  maxOutputBytes?: number
}
interface ExecResult {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
  /** 出参标记：sandbox / container，用于排障与前端解释 */
  runtime: 'sandbox' | 'container'
}

type FsOp =
  | { op: 'list'; path: string }
  | { op: 'listTree'; path: string; maxDepth?: number; excludeDirs?: string[] }
  | { op: 'stat'; path: string }
  | { op: 'read'; path: string }
  | { op: 'readBytes'; path: string }
  | { op: 'write'; path: string; content: string }
  | { op: 'writeBytes'; path: string; base64: string }
  | { op: 'append'; path: string; content: string }
  | { op: 'remove'; path: string }
  | { op: 'search'; path: string; query: string }
interface FsResult {
  ok: boolean
  data?: unknown
  reason?: 'unsafe-path' | 'not-found' | 'exec-failed' | 'unsupported'
  message?: string
}

interface WorkspaceEnvironment {
  readonly kind: 'host' | 'docker'
  readonly features: EnvFeatures
  /** 只读探测：可用性 + 原因（沙箱不可用、daemon 连不上），不产生副作用 */
  probe(): Promise<{ available: boolean; reason?: string }>
  /** 准备环境：建目录 / 校验目录 / 创建容器；幂等 */
  prepare(ref: WorkspaceRef): Promise<WorkspaceRef>
  /** 确保环境还在（多副本 / 被别处回收后重建） */
  ensure(ref: WorkspaceRef): Promise<WorkspaceRef>
  exec(ref: WorkspaceRef, req: ExecRequest): Promise<ExecResult>
  fs(ref: WorkspaceRef, op: FsOp): Promise<FsResult>
  /** keep = 保留数据；purge = 连数据一起删 */
  dispose(ref: WorkspaceRef, mode: 'keep' | 'purge'): Promise<void>
}
```

约束：

- **驱动内部可以用任意手段**（Node fs / dockerode / shell），但必须满足上面原语的**语义**；
- 驱动不 import 工具，不读工具 schema；
- 驱动实例**按工作区解析**（`resolveEnvironment(workspace)`），不是进程级单例；
- 公共流程（锁、超时、输出上限、回收、初始化编排）一律在驱动之外。

## 4. 两种驱动（本版范围）

| 维度 | `HostEnvironment`（本机） | `DockerEnvironment`（容器） |
| --- | --- | --- |
| 根 | `<WORKSPACE_LOCAL_ROOT>/<workspaceId>`（默认）或用户指定的绝对路径 | `/workspace`（容器内固定） |
| 准备 | `mkdir -p`；指定目录时校验（存在、在允许根内、不覆盖凭据目录、沙箱必须可用） | 镜像比对 → 建容器（能力全丢、禁提权、限资源、`/workspace` 内存盘） |
| 执行 | 沙箱包装 `sandbox-exec` / `bwrap`；`shell: sh` | `docker exec sh -c`；工作目录 `/workspace/<cwd>` |
| 文件 | Node fs 直写；原子写用同目录临时文件 + `rename` | 翻译成容器命令（`ls` / `find` / `cat` / base64 / `mv` / `rm`），原子写用临时文件 + `mv -f` |
| 释放 | `keep`：只丢内存记录，目录不动；`purge`：删目录 | `keep`：删容器（数据本来就不持久）；`purge`：同 |
| 探测 | 沙箱能力探测（不可用 → 执行被拒，fail closed） | docker daemon 可达性 + 镜像存在 |
| `features` | `shell: sh`、`sandbox: os`、`network: deny`、`writeHome: false`（沙箱默认不放开）、`installGlobal: false`（沙箱写不了全局前缀）、`persistence: durable`、`resourceLimits: false`（不做资源限制）、`extraReadRoots: 待定`、`multiInstance: false` | `shell: sh`、`sandbox: none`（容器本身就是边界）、`network: configurable`（bridge / none）、`writeHome: true`、`installGlobal: true`、`persistence: ephemeral`、`resourceLimits: true`、`extraReadRoots: 待定`、`multiInstance: false`（同宿主多副本需显式开关 + Redis，不算默认支持） |

> 说明：`HostEnvironment` 的 `writeHome: false` 是按沙箱默认值填的（沙箱只允许写工作区与缓存）；
> 如果部署把 `AGENT_WORKSPACE_SANDBOX=false`，这项会变 `true`，但那就不是受保护环境了，见 §8 待定。

### 4.1 Host 环境的两种形态（含 Windows）

| | Host + 系统沙箱 | Host 无沙箱（Windows / 明确关闭） |
| --- | --- | --- |
| 适用 | Linux / macOS，默认 `enforce` | Windows（先不做隔离）、自托管单机明确选择 |
| `features.shell` | `sh` | `cmd`（PowerShell 同理，按平台画像取） |
| `features.sandbox` | `os` | `none` |
| 命令隔离 | 系统沙箱兜底：只能写工作区与缓存 | **没有隔离**：以服务进程身份执行，只能靠「专用低权限用户 + 目录权限」兜底 |
| 初始化 | 不依赖 shell 也行，但默认仍走 shell | **必须用 Node fs 直写**（不假设 `mkdir -p` / `printf` / `chmod`） |
| 技能 | 物化到工作区 `.agents/`（**默认目录与指定目录都写**） | 物化到工作区 `.agents/`（同一个实现，不依赖 shell） |
| 凭据 / 安装清单 | 跳过：用宿主自己的登录态与已装 CLI | 跳过：同上 |
| 资源限制 | 无（不做内存 / CPU / 进程数 / 磁盘限制） | 无（同上） |
| 状态 | 可用 | **可用（按用户决定：Windows 必须支持，沙箱先忽略）** |

> 隐含契约：容器镜像必须提供 `/bin/sh` —— exec 用 `sh -c`，环境信息里也声明 `shell: sh`。
> 以后若要支持 Windows 容器镜像，必须在镜像配置里声明 shell，不能按平台猜。

> Windows 结论（2026-11-22 定）：必须支持；沙箱先忽略，`features.sandbox = 'none'`。
> 这意味着命令没有系统级隔离，部署时要用专用的低权限账号跑 workspace-service，并只给工作区目录的读写权限。

### 4.2 环境信息注入提示词

现状：`core/prompts/templates/partials/environment.eta` 会在**会话开局**渲染一段「运行环境」，
只有操作系统、命令解释器、当前时间；而且 `shell` 取的是 **runtime 进程**的画像（`/bin/sh`），
不是工作区的——runtime 在 Linux、工作区是容器或 Windows 时，这段信息就是错的。

决定（D7）：把它扩展成「执行环境」片段，字段全部来自 `EnvFeatures` + 工作区解析：

| 字段 | 来源 | 示例 |
| --- | --- | --- |
| 命令解释器 | `features.shell` | `sh（/bin/sh）` / `cmd` / `powershell` |
| 操作系统 | 被解析环境的画像 | `Linux 6.x（debian）` / `Windows 11` |
| 工作区根 | 坐标解析 | `/workspace` / `~/.billy/workspaces/<id>` |
| 隔离 | `features.sandbox` + `network` | `系统沙箱，只能写工作区与缓存；默认断网` / `无隔离，以服务账号身份执行` |
| 资源限制 | `features.resourceLimits` | `2 CPU / 2GB / 512 进程` / `无` |
| 数据持久 | `features.persistence` | `停止后保留` / `停止后清空` |
| 文件权限 | 工作区 `file_access` | `可写` / `只读` |

规则：

- **只在会话开局注入一次**：系统提示是请求前缀，每轮塞变化内容会让提供方前缀缓存失效；
  需要精确时间 / 想知道环境变没变，让模型自己跑一条命令取；
- **建会话时就已能算出环境**：会话创建时一定已绑定工作区（默认工作区缺失会懒创建），
  环境信息由「工作区的配置 + 部署配置 + 进程平台画像」推导即可，**不需要先起容器 / 建目录**；
  唯一需要探测的是「沙箱能不能用」（进程级缓存，失败按不可用算），也不依赖某个工作区；
- **信息只在环境片段里给具体值**，工具描述保持中性（「按执行环境的 shell 语法书写」），
  两处不重复，避免漂移。

## 5. 差异归谁：三类与三问

**三类差异**

| 类型 | 例子 | 处理位置 |
| --- | --- | --- |
| A 能力有/没有 | 能不能出网、能不能写 HOME、有没有资源限额 | `EnvFeatures` |
| B 同一动作语义必须一致 | 列表是否含隐藏文件、搜索是否区分大小写、符号链接是否跟随、写是否原子 | 驱动各实现一份，同一套一致性测试收口 |
| C 入参与描述随环境变 | Windows 上命令是 cmd 语法；断网环境不能 `git clone` | 按 `features` 生成工具描述与校验，工具仍只有一份 |

**三问规则**

1. 这是「有没有」还是「怎么做」？有/没有 → `features`；怎么做 → 驱动内部。
2. 换个环境，这个动作的含义变了吗？没变 → 各实现一次 + 一致性测试；变了 → 才允许开新工具。
3. 只有描述或报错不同？→ 按 `features` 生成文案，不复制实现。

## 6. 一致性测试清单（每个驱动都要过）

| 用例 | 断言 |
| --- | --- |
| 写后读回 | 内容完全一致（含中文、emoji、CRLF） |
| 原子写 | 并发读不会读到半截；写完不残留临时文件 |
| 列目录 | 隐藏文件、子目录、空目录、中文文件名 |
| 列树 | 深度上限、排除目录、符号链接不跟随 |
| 搜索 | 命中路径正确、二进制文件不崩、无命中返回空 |
| 越界 | `../`、绝对路径、软链逃逸 → `unsafe-path`，不落盘 |
| 删除 | 文件 / 目录递归；不存在时不报错 |
| 大文件 | 超输出/预览上限时截断或明确拒绝，不 OOM |
| 执行超时 | 超时被杀、返回 `timedOut`、不留孤儿进程 |
| 输出截断 | 按字节截断，中文不乱码 |
| env 注入 | 带空格 / 单引号 / `$` / 换行的值不被解释成语法 |
| 并发写同路径 | 串行、最终内容为最后一次写入 |

## 7. 现状 → 目标映射

| 现状 | 去处 |
| --- | --- |
| `ContainerDriver`（6 个动作，无 fs） | 提升为 `WorkspaceEnvironment`，补 `fs` 与 `features` |
| `DockerDriver` / `KubernetesDriver` 两个类 | Docker 保持并补 fs；**K8s 本版不动**，只保留接口兼容性说明 |
| 运行时里的 `localFs` | 搬进 `HostEnvironment.fs` |
| 运行时里的 `containerFs` | 搬进 `DockerEnvironment.fs`（命令翻译） |
| 9 处 `backend === 'local'` 分支 | 拆成：坐标解析（执行面）、原语调用（驱动）、策略（声明） |
| `withEnvPrefix`（拼 `env K=V sh -c`） | 变成驱动的 env 翻译；工具与执行面不再拼 shell 字符串 |
| 初始化四段（装包 / 技能 / 凭据 / 标记） | 保留在策略层，按 `features` 分流：Host 只做技能物化 + 目录；Docker 四段全做 |
| `containerRuntime` 进程级全局 | 改为 `resolveEnvironment(workspace)` 按工作区解析 |
| `image` / `location` 自由字段 | 坐标收敛（host：目录 + managed；docker：镜像 + 网络），仍有 JSON 兼容层 |
| 技能清单（系统提示）与正文 | 清单改为按工作区可见技能生成；过滤规则抽到共享包，runtime 与 workspace-service 用同一份（避免两处漂移） |

## 8. 落地顺序（每步都可回滚）

**P1 · 适配层（行为不变）** —— ✅ 已落地（2026-11-22）

- 加 `WorkspaceEnvironment` 接口与 `resolveEnvironment`；
- 把现有运行时包成一个「兼容驱动」：`exec` 直通，`fs` 仍调现有的两套实现；
- 能力改为依赖会话接口（内部仍走老路径）；
- 验收：现有 115 + 184 测试全绿，typecheck / verify 通过。

**P1.5 · 驱动层落地**（2026-11-22）：`environment/types.ts` 定义 `WorkspaceDriver`（probe / prepare / exec / fs / dispose），
`environment/host.driver.ts` 与 `environment/container.driver.ts` 各实现一份；运行时只做坐标解析 + 流程，不再有 `backend` 分支的 exec/fs。

**P2 · fs 与 env 下沉** —— ✅ 落地（2026-11-22）：声明、Host 初始化策略、Node fs 写文件、技能标记与删除保护、fs 抽成独立模块（`fs/host-fs.ts` / `fs/container-fs.ts`）、按 shell 注入 env、技能列举改 `listDirs` 已完成；环境信息进提示词（`/v1/workspaces/environment` + 首轮渲染）、`bash` 描述中性化也已完成

- `HostEnvironment.fs` = 现有 localFs 搬家；`DockerEnvironment.fs` = 现有 containerFs 搬家；
- 工具改为只调 `session.fs(op)`；删除运行时里的两套分支；
- env 改成请求参数，驱动自己翻译；
- 初始化策略按 `features` 分流：Host 只物化**技能**（Node fs 直写，两种 Host 形态都做）+ 保证目录存在；装包与凭据跳过；Docker 保持现状；
- 指定目录也物化技能，并加「只删自己写的」保护（标记文件）；
- 环境片段改成按工作区声明渲染（替换现在取自 runtime 进程的 `shell`），数据来自工作区配置 + 部署配置 + 平台画像，不依赖 prepare；
- 技能「清单与正文同源」：把 `visibleSkillsOf` 的过滤规则抽到共享包，runtime 按会话绑定的工作区算出清单（不再扫全量 `~/.billy/skills` 出清单）；
- 配置项改名：`AGENT_WORKSPACE_SANDBOX` → `AGENT_WORKSPACE_SANDBOX`（`workspace.sandbox` 布尔），旧键兼容一个版本；
- 验收：一致性测试清单全绿；既有工作区目录无需迁移（布局未变）。

**P3 · 驱动注册与多模式** —— ✅ 落地（2026-11-22）：`resolveEnvironmentOf`（kind + 声明）、`GET /info`、fs 一致性测试、**按工作区选驱动**（`ai_workspaces.driver`：host / container / pod，空 = 推导）+ 驱动层实现（`environment/`）+ 后台选择；剩 Windows 实机验证

- 驱动按工作区解析，支持一个部署里同时跑 host 与 docker；
- 声明进 `/info` 与日志，前端按声明展示「能不能联网 / 数据会不会丢」；
- 验收：同一套能力在两个环境各跑一遍集成测试。

**K8s（暂缓）**：不动代码；未来接入需要补齐两件——`fs` 走 `kubectl exec`、`multiInstance` 下锁与回收语义，届时再评审。

## 9. 决策记录与仍待定

### 9.1 已定（2026-11-22）

| # | 问题 | 结论 |
| --- | --- | --- |
| D1 | Host 环境要不要搬技能 / 凭据 / 装包 | **技能搬**（物化到工作区 `.agents/`，**默认目录与指定目录都写**，不依赖 shell）；**安装清单与凭据不搬**（用宿主自己的 CLI 与登录态）。只保证目录存在，没有就建。凭据是否也要搬待定（见 §9.2 Q1） |
| D2 | 沙箱开关的命名 | 把 `AGENT_WORKSPACE_SANDBOX=true/off` 改成布尔：**`AGENT_WORKSPACE_SANDBOX=true/false`**（配置字段 `workspace.sandbox`），`true` = 原 `enforce`，`false` = 原 `off`。旧键在 P2 期间兼容读取并打弃用告警 |
| D3 | Windows 是否进支持矩阵 | **必须支持**；沙箱先忽略（`sandbox: 'none'`）；初始化改成不依赖 POSIX 命令 |
| D4 | `destroy` 语义 | Host：只删数据库记录，**工作区目录保留**；Docker：删容器，**数据一起清掉**。即 `dispose` 的 `keep`（Host）与 `purge`（Docker）是各自默认 |
| D5 | 技能正文从哪里读 | **只从工作区 `.agents/` 读**（容器 `/workspace/.agents/`、Host 工作区目录），因此 Host 的两种形态都要物化技能；系统提示里的技能清单也必须按「这个工作区物化了哪些」生成，不能再用 runtime 扫全量库（否则撤销授权后清单残留、正文已删，两边对不上） |

| D8 | 一套部署里能不能混跑 docker / k8s | 能：工作区持久化 `driver` 列（`host` / `docker` / `kubernetes`，空 = 按 backend 与部署默认推导），驱动按工作区**按需创建**并缓存；后台新建工作区可选「自动 / Docker / Kubernetes」 |
| D7 | 环境信息怎么让模型知道 | 会话开局在系统提示里注入「执行环境」片段（shell / 操作系统 / 工作区根 / 隔离与网络 / 资源限制 / 数据持久 / 文件权限），由 `EnvFeatures` 生成；建会话时按「工作区配置 + 部署配置 + 平台画像」推导即可（不必先起环境），工具描述不重复写具体值 |
| D6 | 指定目录里怎么删「不再可见的技能」 | 只删**我们自己写过**的目录：物化时在 `.agents/<key>/` 里留一个标记文件，同步/收敛时只删除带标记的目录；仓库里同名或无关的 `.agents/*` 一律不动 |

### 9.2 仍待定

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | Host 的凭据要不要也搬（写 `~/.config/gh` 这类） | 建议**不搬**：用宿主自己的登录态；平台代管的凭据只走环境变量 |
| Q2 | `off` / `sandbox=false` 时后台要不要提示「不受保护」 | 建议提示，读 `features.sandbox` |
| Q4 | 「环境信息进提示词」怎么取到声明 | **已定**：runtime 直连 workspace-service（`WORKSPACE_SERVICE_URL` + `WORKSPACE_INTERNAL_TOKEN`），首轮查一次；查不到就整段省略（记 warn，不阻断问答） |
| Q3 | 并发与超时是否也要放开（用户说「host 不限制资源」） | 资源（内存 / CPU / 进程数 / 磁盘）不做；**并发仍保持 1 条、单命令 300 秒、输出 64KB**——这三项是行为上限，不是资源限制，放开会出乱序与打爆内存 |

## 9.3 文件组织（workspace-service）

按「单一职责」拆开后的目录（2026-11-22）：

```
src/workspace/
  workspace-runtime.service.ts   # 只做流程：解析 → 声明 → 锁 → 调原语 → 回收
  workspace.controller.ts        # HTTP 边界
  workspace.repository.ts        # ai_workspaces 只读
  workspace-coordinator.ts       # 跨副本锁与 lastUsed
  workspace-reaper.service.ts    # 空闲回收
  features.ts                    # 环境声明（纯函数）
  host-root.ts                   # 目录解析与校验
  skill-visibility.ts            # 技能可见性
  keyed-mutex.ts                 # 进程内按 key 串行
  environment/
    types.ts                     # WorkspaceDriver 接口（probe / prepare / exec / fs / dispose）
    host.driver.ts               # 宿主驱动：沙箱执行 + Node fs
    container.driver.ts          # 容器驱动：docker / k8s 共用（起停 / exec / 命令翻译）
  fs/
    host-fs.ts                   # Node fs 实现
    container-fs.ts              # 命令翻译实现
    find-tree.ts                 # 一次 find 取整棵树
    path.ts / tmp.ts             # 边界判断 / 临时文件名
  exec/
    env.ts                       # 按 shell 注入环境变量（sh / cmd）
    output.ts                    # 输出上限与字节截断
  setup/
    setup.service.ts             # 初始化编排（装包 / 技能 / 凭据 / 标记）
    shell.ts                     # SetupShell：exec 版 + Node fs 版
    pure.ts                      # 纯函数：装包命令、哈希、模板渲染
  container/
    driver.ts                    # 容器接口 + docker / k8s 实现
  credential/
    gate.ts / client.ts / main.client.ts
    import.service.ts / save.service.ts / cli-adapters.ts
```

## 9.4 已落地清单（2026-11-22）

| 项 | 位置 |
| --- | --- |
| 声明 | `packages/contracts/src/workspace-env.ts`、`apps/workspace-service/src/workspace/features.ts` |
| 按工作区解析 | `resolveEnvironmentOf`（返回 kind + 声明） |
| 部署信息 | `GET /info`（平台 / 沙箱 / 容器运行时 / 目录配置） |
| 工作区环境查询 | `POST /v1/workspaces/environment` → runtime 首轮提示词 |
| 驱动层 | `environment/types.ts` + `host.driver.ts` + `container.driver.ts`（用例 `test/environment-driver.test.ts`） |
| fs 一致性 | `test/fs-contract.test.ts`（同一组用例跑 host 与容器实现） |
| 按工作区选驱动 | `ai_workspaces.driver`（空 = 推导）；驱动按工作区按需创建 |
| 部署提示 | `POST /ai-workspace/server-info` → 后台在工作区页提示「沙箱已关闭」 |

| D9 | 建工作区要不要让用户选后端 / 填路径 | 不要：用户只填名称，界面只告知「会保存在哪」；存哪由部署配置 `WORKSPACE_DEFAULT_DRIVER`（host / container / pod）决定；**驱动创建时定死，之后不可更改**（换驱动 = 换环境，数据不迁移，只能新建工作区） |

## 10. 明确不做

- 不把工具实现搬进驱动（工具一份，差异靠声明与文案）；
- 不在本版动 `kubernetes` 驱动与多副本；
- 不改工作区目录布局（`<root>/<workspaceId>`），也不迁移已有目录；
- 不动会话文件服务（`file-submit` / `file-download` 属对象存储侧，与执行环境无关）。
