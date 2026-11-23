# 工作区预览：给工作区一个可访问的 URL

> 状态：**设计稿（2026-11-23）**，待评审。本文只定方案，不代表已实现。
>
> 关联：[workspace.md](workspace.md)（工作区概念与驱动）、
> [workspace-env-contract.md](workspace-env-contract.md)（驱动抽象）、
> [workspace-conversation-workdir.md](workspace-conversation-workdir.md)（会话工作目录规范）、
> [ai-file-manager.md](ai-file-manager.md)（会话文件与已有预览）、
> [distributed-ai-architecture.md](distributed-ai-architecture.md) §12 的 L3「长驻 dev server / 预览 URL」。
>
> 依赖：预览根按会话目录（`conversations/<id>/public/`）；会话目录细节以 [workspace-conversation-workdir.md](workspace-conversation-workdir.md) 为准，本文目录约定待按它更新。

## 0. 设计摘要

**每个工作区有一个自己的本地 HTTP origin（IP + 端口），静态站点用 `serve`、NestJS 等应用用自己的进程监听这个端口。数据面由浏览器直连工作区端口，不经过 main / workspace-service。**

| 维度 | 结论 |
| --- | --- |
| 范围 | 默认一个会话一个服务；一个工作区可同时有多个会话预览；共享项目单独一个工作区服务 |
| 开启方式 | **默认关闭；用户在工作区页「预览」面板手动开启后才可访问；AI 不自动开启** |
| URL | 本机 `http://127.0.0.1:<port>`；局域网 `http://<宿主局域网IP>:<port>` |
| 数据面 | `browser → 工作区端口`（直连）；main / workspace-service 只在控制面 |
| 网关 | 本地阶段不引入 Kong；有域名 / TLS 的生产化阶段再加子域名 + Kong |
| 鉴权 | 本期不做；URL 本身就是访问凭证；仅适合本机 / 可信局域网 |
| 端口 | host 随机；container 固定 `3000` 发布到宿主随机端口 |
| 成本 | 粗估约 2 周（不含生产域名、鉴权、多服务、k8s） |

## 1. 产品视角

### 1.1 问题

AI 现在能在工作区里写多文件站点、也能跑 NestJS，但用户拿不到一个“能打开”的地址：

- 右栏文件树只能逐个文件看，HTML 走沙箱预览，**多文件站点的相对资源直接失效**；
- 单文件 HTML 能预览，但能力受限：没有 CSS/JS/图片目录、没有前端路由、没有接口；
- NestJS 这类应用根本没有入口，只能让用户下载到本地跑；
- 做出来的东西**没法发给同事**，也没法在真实浏览器里验收。

### 1.2 用户与场景

| 角色 | 场景 | 期望 |
| --- | --- | --- |
| 管理员（工作区 owner） | AI 做完一个多文件站点 / NestJS 服务 | 点一下打开，真实浏览器能看 / 能调 |
| 局域网同事 | 收到一个 `http://<IP>:<port>` | 在同一局域网内直接打开 |
| AI 自己 | 写完后要验证页面 / 接口 | 准备文件 / 构建；提示用户去工作区页「预览」面板手动开启（不自行暴露端口） |

### 1.3 目标与非目标

**目标**

1. 一个工作区一个 URL，打开就是工作区里正在跑的东西；
2. 静态多文件（HTML/CSS/JS/图片）和动态应用（NestJS 等）走同一套；
3. 数据面 `browser → 工作区端口`，不经过 main / workspace-service；
4. 本机优先，局域网可共享；不依赖域名 / DNS；
5. 启动 / 停止 / 状态 / 日志可管理，工作区回收时能收干净；
6. **预览默认关闭；只有用户在工作区页「预览」面板手动开启后，端口才对外可用；关闭立即失效。**

**非目标（v1 明确不做）**

- 平台级鉴权 / 登录 / 按人授权（URL 即 capability）；
- AI 自动开启 / 暴露预览；
- 域名、子域名、TLS、Kong（留给生产化阶段）；
- 一个工作区多个服务（前端 + 后端各一个端口）；
- k8s；
- 公网访问 / 端口转发 / 反向代理；
- 保证 HMR / 热更新；只保证 HTTP 与 WebSocket 能通；
- 工作区运行状态的持久化 / 快照 / 归档。

### 1.4 MVP 范围与验收

**MVP**

- 默认一个会话一个预览服务；一个工作区可同时有多个会话预览；共享项目单独一个工作区服务；
- 两种类型：`static`（平台起 `serve`）/ `command`（用户在面板里选择/输入启动命令，如 `pnpm start:dev`）；
- **工作区页「预览」面板：手动开启 / 关闭；默认关闭；AI 不自动开启**；
- 启动、停止、状态、日志；
- URL：本机 `http://127.0.0.1:<port>`；局域网 `http://<宿主局域网IP>:<port>`；
- 无鉴权；静态默认只服务会话目录下的 `public/`。

**验收用例**

| # | 场景 | 期望 |
| --- | --- | --- |
| E0 | 默认状态 / AI 写完文件 | 预览关闭，端口没监听，URL 不可访问；AI 不会自动开启 |
| E1 | 用户在工作区页点「开启预览」（静态） | 平台起 `serve`，本机打开 URL 正常，资源全部 200 |
| E2 | 用户开启 NestJS（`pnpm start:dev`，`PORT=3000`） | URL 打开；`/api` 可调；WebSocket（若有）可连 |
| E3 | 局域网同事访问 | 绑 `0.0.0.0`、URL 用宿主局域网 IP，能打开 |
| E4 | 用户点「关闭预览」 | 端口释放；URL 连接失败；进程消失 |
| E5 | 停止 / 删除工作区 | 预览先停；容器删除；URL 失效 |
| E6 | 工作区空闲 2h | 有活跃预览时不被回收；超过预览 TTL 后停止并回收 |
| E7 | workspace-service 重启 | 容器内应用仍在跑 → 状态恢复；端口不变（inspect / 状态文件） |
| E8 | 数据面核验 | 打开页面 / 拉资源时，main / workspace-service 没有请求日志 |
| E9 | 端口冲突 / 应用没监听 | 启动失败，错误文案带日志尾部 |

### 1.5 交互

**工作区页「预览」面板**

- 卡片上「预览」按钮，打开面板；默认状态「未开启」；
- 面板内容：
  - 开启 / 关闭开关；
  - 模式：`静态站点（public/）` / `应用（命令）`；
  - 命令模式下填启动命令（如 `pnpm start:dev`），端口由平台注入；
  - 开启后显示 URL、复制、打开、绑定范围（仅本机 / 局域网）、日志入口；
  - 提示：开启后任何拿到 URL 的人都能访问；关闭立即失效。
- 开启时如果工作区没在跑，先拉起工作区，再起服务；失败显示原因 + 日志尾部。

**聊天 / timeline**

- AI 不提供开启入口，也不自动起服务；
- AI 写完 / 构建完后提示「去工作区页「预览」面板开启」；
- 如果用户已经开启，timeline 可以显示 URL；未开启时显示「预览未开启」的提示，不做开启按钮；
- 静态站点可选 iframe（`X-Frame-Options` 允许时），NestJS 建议新标签打开。

### 1.6 指标

- 从「用户点开启」到「URL 可打开」的时间；
- 手动开启率、开启后访问率、关闭 / 过期比例；
- 启动成功率、p50/p95 启动耗时、失败原因分布；
- 活跃预览数、平均存活时长；
- URL 复制 / 打开次数（前端埋点，可选）。

### 1.7 对标与取舍

| 产品 | 做法 | 可借鉴 / 不采用 |
| --- | --- | --- |
| Vercel Preview | 每次部署一个 URL，可加访问保护 | 借鉴“一次产出一个 URL”；v1 不做访问保护 |
| CodeSandbox / E2B | 每个 sandbox 一个端口 URL | 借鉴“每环境独立 origin”；v1 不做域名 |
| GitHub Codespaces | 端口转发，默认私有 | 借鉴端口 → URL；v1 用户自己打开端口 |
| 本方案 | 本机 / 局域网直连端口 + 用户手动开启 | 简单、无 DNS、无网关；默认不暴露；生产化再换稳定 URL |

## 2. 技术视角

### 2.1 架构与数据流

```
数据面（每个请求）：
  browser
    → http://<宿主IP>:<port>
    → 工作区端口（serve 或 NestJS）
  不经过 main / workspace-service

控制面（低频）：
  用户在工作区页「预览」面板点开启
    → main（鉴权 / 归属 / 控制 API）
    → workspace-service（起进程 / 等端口 / 状态 / 日志）
```

### 2.2 组件与职责

| 组件 | 职责 | 不做什么 |
| --- | --- | --- |
| `workspace-service` | 预览服务管理器：端口分配、起停进程、就绪探测、日志、注册表、回收联动 | 不写 `ai_workspaces`；不做用户鉴权 |
| `main` | 控制面 API（启动 / 停止 / 状态 / 日志）、`AdminAuthGuard` + 归属校验、SDK | 不做数据面转发 |
| `admin` | 工作区页「预览」面板、timeline 状态提示、日志弹窗 | 不直接连 workspace-service |
| `agent-runtime` | 提示词 / 引导用户去工作区页开启 | 不执行进程、不自动开启预览 |
| `@repo/contracts` | 预览启动 / 停止 / 状态 / 日志 schema | — |

### 2.3 URL 与端口

**同一个工作区一个 origin：`IP + 端口`。** 不使用域名 / 子域名 / 路径前缀。

| 访问者 | URL | 绑定 |
| --- | --- | --- |
| 本机浏览器 | `http://127.0.0.1:<port>` | host 进程 / container 发布端口都绑 `127.0.0.1` |
| 局域网同事 | `http://<宿主局域网IP>:<port>` | 必须绑 `0.0.0.0`（或宿主局域网 IP）；URL 里的 host 用局域网 IP |

- 默认 `WORKSPACE_PREVIEW_BIND=127.0.0.1`，只允许本机；要共享给局域网，显式改成 `0.0.0.0`，并把 `WORKSPACE_PREVIEW_PUBLIC_HOST` 设成宿主局域网 IP。
- 容器端口发布默认 `127.0.0.1:<hostPort>`；共享局域网时发布到 `0.0.0.0:<hostPort>`。
- 应用看到的是 `/`；绝对路径、SPA、Swagger、WebSocket 不需要改。
- **端口是 URL 的一部分**：host 重启后尽量复用原端口（状态文件），container 的宿主端口在创建时固定；如果端口变了，旧 URL 失效，UI 返回新 URL。
- 生产化（有域名 / TLS 时）再上子域名 + Kong；预览管理器只换 URL / 路由层，工作区 origin 不变。详见 §2.15。

### 2.4 端口与驱动

| 驱动 | 工作区监听 | 浏览器访问 | 说明 |
| --- | --- | --- | --- |
| `container` | 容器内 `0.0.0.0:3000` | `http://<宿主IP>:<hostPort>` | 容器创建时把 `3000/tcp` 发布到宿主随机端口；`hostPort` 从 inspect 恢复 |
| `host` | `127.0.0.1:<随机>` 或 `0.0.0.0:<随机>` | `http://127.0.0.1:<port>` / `http://<局域网IP>:<port>` | 按 `WORKSPACE_PREVIEW_BIND` 决定绑定 |

约束：

- **容器创建后不能加端口**，所以 `container` 驱动必须在 `docker create` 时发布 `3000/tcp`；即使这次不启动预览，也先发布一个宿主端口（成本是一个空闲端口）。
- 容器内进程必须监听 `0.0.0.0`；监听 `127.0.0.1` 时 Docker 的端口映射进不去。
- host 的 `serve` / 应用按 `WORKSPACE_PREVIEW_BIND` 绑定：默认 `127.0.0.1`；局域网共享时 `0.0.0.0`。
- 默认一个会话一个端口；一个工作区可同时有多个会话预览；共享项目一个工作区端口；多服务（同一会话前端 + 后端）后续用端口段或一个应用聚合。

#### 目录约定

会话工作目录、`.agents` / `.billy` 的共享位置、`shared/`、老会话回落，统一以 [workspace-conversation-workdir.md](workspace-conversation-workdir.md) 为准。预览只约定一件事：每个会话的静态根默认是 `conversations/<rootConversationId>/public/`（host / container 同构）；日志与状态仍按 §2.6。

### 2.5 两类服务

#### static（平台起 `serve`）

- 命令：`serve <root> -l <port> -n -L --no-port-switching`（`<port>` 形式即 `0.0.0.0:<port>`；要绑指定 IP 用 `-l tcp://<ip>:<port>`，实测 `-l 127.0.0.1:port` 会报 `Unknown --listen endpoint scheme`）。`-l` 按 `WORKSPACE_PREVIEW_BIND` 选择：`0.0.0.0` 用 `<port>`，具体 IP 用 `tcp://<ip>:<port>`。
- `<root>` 默认会话目录下的 `public/`；`root` 可覆盖，需在 UI / 提示词说明“服务整个工作区根会把 `.billy`、`.git`、`.env` 暴露”。
- `serve.json` 设 `directoryListing: false`；SPA 用 `-s` 回退 `index.html`。
- **不使用 `-C`**：实测 `serve -C` 返回 `Access-Control-Allow-Origin: *` + `Allow-Credentials: true` + `Allow-Private-Network: true`，既是不合法组合，也允许任意公网页面访问本地预览；CORS 由应用 / 前端按需处理。
- 版本 / 安装：`serve` 必须在**进程所在环境**里存在——host 进程用 PATH（本机实测 14.2.6）；workspace-service 容器（host 驱动）和 workspace 容器（container 驱动）推荐把 `serve@14.2.6` 预装进镜像，首次 `npm i -g serve@14.2.6` 作兜底；`WORKSPACE_CONTAINER_NETWORK=none` / 断网时必须预装。

#### command（应用自己监听）

- 入参：`command`、`cwd`（相对会话目录）、`readyPath`（默认 `/`）、可选 `env`。
- 平台注入 `PORT`：container 固定 `3000`；host 随机。应用必须读 `process.env.PORT` 并监听 `0.0.0.0`（容器）或按绑定地址（host）。
- 例：`pnpm start:dev`、`node dist/main.js`、`uvicorn app:app --host 0.0.0.0 --port $PORT`。
- 进程必须 detached，不能走 `bash`（task 有 300s / 30 分钟限制，会被杀）。
- **host 自定义 command 策略**：沙箱开启时不允许（直接 spawn 会绕过 L1 沙箱），host 只支持 `static`；仅 `AGENT_WORKSPACE_SANDBOX=false` 的自托管部署允许 host command。`command`（NestJS 等用户代码）默认走 container。沙箱内 + network allow 的长驻进程作为后续能力。

### 2.6 进程生命周期

**启动**

```
用户在工作区页「预览」面板点开启
  → main 校验身份/归属
  → workspace-service.ensure(workspaceId)
  → 分配/恢复端口
  → 起进程（detached）
  → 等就绪（TCP + HTTP）
  → 返回 { url, port, status: running }
```

**就绪探测**

- host：`GET http://<实际监听地址>:<port><readyPath>`；container：`docker exec <容器名> curl -fsS http://127.0.0.1:3000<readyPath>`。
- 连接失败重试；HTTP 2xx/3xx 视为就绪；401/403 也视为就绪（应用自己有鉴权）；5xx 继续等。
- 超时默认 30s（static）/ 60s（command，NestJS 可能要先编译）；可配；失败则杀进程、返回日志尾部（最后 100 行）。

**停止**

- host：`SIGTERM` → 5s → `SIGKILL`；Windows 用 `taskkill /T /F`。
- container：`setsid` 起进程组，按 PID 文件 `kill -TERM -<pid>`；或唯一 marker + `pkill -f`；停止时只命中本次服务的进程组 / marker。
- 先释放端口 / 杀进程，再清注册表；任何一步失败记日志，不阻断下一步。

**日志**

- host：`.billy/preview/<rootConversationId>.log`（平台元数据目录，不在 `public/` 下）；
- container：`/tmp/billy-preview-<rootConversationId>.log`（不写 `/workspace`，避免被 `serve` 暴露）；
- 单文件上限 1MB，轮转或截断；日志 API 只回最后 N 行，脱敏。

**崩溃 / 重启**

- 应用崩溃：状态 `failed`，不自动重启（v1）；日志可查；用户手动重开。
- workspace-service 重启：container 用 `docker inspect` 恢复 hostPort + `docker exec` 检查进程；host 读 `.billy/preview/<rootConversationId>.json`（pid/port/kind）并检查端口；恢复后返回原 URL。
- 容器重建（镜像变更）：hostPort 变化，URL 变化；UI 返回新 URL。

### 2.7 数据与接口

> 本节仍是单服务版（key = workspaceId）；多会话版按 `(workspaceId, conversationId)` 扩展，待 [workspace-conversation-workdir.md](workspace-conversation-workdir.md) 落地后更新。

**运行时注册表（不落 DB）**

```ts
interface WorkspacePreviewState {
  workspaceId: string
  driver: 'host' | 'container'
  kind: 'static' | 'command'
  status: 'starting' | 'running' | 'failed' | 'stopped'
  port: number          // 工作区内的监听端口
  hostPort?: number     // container 发布到宿主的端口
  url: string           // 浏览器访问地址
  pid?: number          // host / container 进程组
  startedAt?: number
  lastReadyAt?: number
  lastError?: string
}
```

- 单副本：进程内 Map；多副本：Redis `workspace:preview:<workspaceId>`（后续）。
- host 额外写 `.billy/preview/<rootConversationId>.json`（pid/port/kind，不含命令与敏感 env）；container 从 `docker inspect` 恢复。
- 不新增 DB 表（v1）；审计靠日志 / 事件。

**契约（`@repo/contracts`）**

- `WorkspacePreviewStartSchema`：`{ workspaceId, kind, command?, root?, cwd?, readyPath?, port? }`
- `WorkspacePreviewStopSchema` / `WorkspacePreviewStatusSchema` / `WorkspacePreviewLogsSchema`
- `WorkspacePreviewStateSchema`：`{ workspaceId, url, status, port, startedAt, lastError? }`

**内部 API（workspace-service）**

- `POST /v1/workspaces/preview/start|stop|status|logs`，`x-internal-token`。

**控制面（main）**

- `POST /ai-workspace/preview/start|stop|status|logs`，`AdminAuthGuard` + `requireOwned`。
- SDK、admin 工作区页「预览」面板、timeline 状态提示。

**AI 的角色**

- AI 不提供开启 / 停止工具，也不自动暴露端口；
- AI 只准备会话目录下的 `public/` 文件或构建应用，然后提示用户去工作区页「预览」面板手动开启；
- 提示词：常驻服务不通过 `bash` 启动；预览必须由用户在面板开启。

**错误码**

- 建议新增 343x：`preview-disabled` / `preview-start-failed` / `preview-port-conflict` / `preview-not-ready` / `preview-not-found`；实现时对齐 `AppErrorCodes` 的段位。

### 2.8 生命周期与回收

- **用户点击开启才启动**：预览进程只在用户于工作区页「预览」面板点开启后才启动；未开启时端口没有监听，URL 不可访问。
- **AI 不自动开启**：AI 没有开启工具，提示词也禁止它用 `bash` 起常驻服务；但 `bash` 仍是可执行能力，产品开关不是对抗性安全边界，真正的隔离靠工作区 / 容器边界。
- **活跃预览要挡住空闲回收**：预览请求直连应用，不经过 workspace-service，回收器不知道有人在看；预览运行期间由 workspace-service 周期性 touch `lastUsedAt`（或回收器检查 active preview 并跳过）。
- **预览最大存活时间**：建议默认 8h（可配）；到期自动停止并允许工作区回收，避免“一个 URL 把容器钉住一辈子”。
- 工作区 `stop` / `destroy` / 回收：先停预览，再释放环境；container 删除时端口自动释放。
- 多副本：v1 单副本；多副本时进程归属一个实例，注册表进 Redis，回收器按锁协调。

### 2.9 安全边界

- **URL 即权限**：`IP + 端口` 本身就是访问凭证；本机默认只绑 `127.0.0.1`，共享局域网才绑 `0.0.0.0`。v1 适合本机 / 可信局域网。
- **默认关闭**：只有用户在工作区页「预览」面板点开启后，端口才监听；未开启时 URL 不可访问。
- **AI 不自动开启**：AI 没有开启工具；提示词禁止它用 `bash` 起常驻服务。产品开关不是对抗性安全边界，真正的隔离靠工作区 / 容器边界。
- **静态默认只服务会话目录下的 `public/`**：`.billy/credentials.json`、`.git`、`.env` 不通过预览 URL 暴露。
- **container 宿主端口**：默认绑 `127.0.0.1`；共享局域网时绑 `0.0.0.0`，需要防火墙 / 安全组收口。
- **跨工作区**：container 端口发布到宿主后，另一个工作区容器可以通过宿主地址访问它；v1 无鉴权，这是已知风险。缓解：端口绑专用内网 IP + 防火墙，或后续加 token / 网络策略。
- **host command**：策略见 §2.5；沙箱开启时不允许 host command。
- **日志脱敏**：不打印命令里的密钥 / env；日志 API 只回尾部并脱敏。
- **CORS**：应用自己控制；平台不注入 `*`；不使用 `serve -C`。

### 2.10 可观测性

- 日志事件：`workspace.preview.start` / `.ready` / `.failed` / `.stop` / `.reap_skipped` / `.expired`。
- `GET /info` 增加：`preview.enabled`、`preview.bind`、`preview.publicHost`、`preview.serveVersion`。
- 指标（可选）：活跃预览数、启动耗时、失败数。
- 应用自己的日志；没有网关层日志。

### 2.11 失败模式

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 启动超时 | 应用没监听 / 端口冲突 | 返回日志尾部；换端口重试 |
| URL 连接失败 | 进程崩了 / 端口释放 / 容器被回收 | 状态 `failed`；重开 |
| 局域网打不开 | 绑了 `127.0.0.1` / 防火墙 | 改绑 `0.0.0.0`，URL 用局域网 IP |
| 容器内应用访问不到 | 应用监听 `127.0.0.1` | 提示监听 `0.0.0.0` |
| 静态资源 404 | 服务根不对 / 文件不在会话 `public/` | 看 `root` 与目录结构 |
| CORS 报错 | 应用没开 CORS / 重复头 | 应用侧配置；避免同时开 `serve -C` |
| WebSocket 断 | 应用 / 代理层 | 本地直连没有网关；检查应用自身 |
| 进程杀不掉 | Windows / 进程组 | `taskkill /T /F`；setsid 进程组 |
| 回收器把预览杀了 | 预览未 touch / 未跳过 | active preview 心跳；TTL |

### 2.12 测试

- 单测：端口选择 / 复用；`serve` 命令拼装（含 `-l` 语法）；就绪判定；注册表状态迁移；TTL。
- 集成：假 container driver（port bindings / inspect）；真实 `serve`（本地静态站点）。
- e2e：默认关闭（URL 不可访问）；用户在工作区页开启；多文件静态站点；NestJS fixture（GET / POST / WS）；关闭；工作区 stop；端口恢复。
- 手工：本机打开、局域网打开、复制、iframe、日志弹窗；按 `workflow.md` 不跑无头浏览器，界面交用户验。

### 2.13 部署与灰度

- 本地阶段不需要 Kong / DNS / TLS；只需要 workspace-service 能访问工作区端口（本机直连）。
- 配置：
  - `WORKSPACE_PREVIEW_ENABLED`
  - `WORKSPACE_PREVIEW_BIND`（默认 `127.0.0.1`；局域网共享改 `0.0.0.0`）
  - `WORKSPACE_PREVIEW_PUBLIC_HOST`（默认 `127.0.0.1`；局域网共享填宿主局域网 IP）
  - `WORKSPACE_PREVIEW_MAX_MS`（默认 8h）
  - `WORKSPACE_PREVIEW_SERVE_VERSION`（默认 14.2.6）
- 功能开关：`WORKSPACE_PREVIEW_ENABLED` 是部署开关；用户面板里的开启是运行时开关，默认关闭、不持久化。关闭部署开关时 `preview-start` 返回 `preview-disabled`，不影响工作区其他能力。
- **存量容器**：上线前创建的 workspace 容器没有 `3000/tcp` 映射；预览前检测到缺失时要提示“需要重建容器”（重建会丢容器内数据），或在发布说明里要求重建；重建需明确提示，不得在用户不知情时进行。

### 2.14 关键决策

| # | 决策 | 结论 | 原因 |
| --- | --- | --- | --- |
| D1 | URL | 本机 / 局域网直连 `IP + 端口` | 当前没有域名；不需要 DNS / 网关；应用看到 `/` |
| D2 | 数据面 | 浏览器直连工作区端口 | 不经过 main / workspace-service |
| D3 | 网关 | 本地阶段不引入 Kong | 没有子域名时 Kong 无法按 Host 分流；直连更简单 |
| D4 | 鉴权 | 本期不做，URL 作为 capability | 本机 / 可信局域网先闭环；后续可加预览令牌 |
| D5 | 服务与端口 | 默认一个会话一个；共享项目一个工作区；container 3000 / host 随机 | 容器端口创建时定死；host 灵活 |
| D6 | 注册表 | 运行时内存 + `.billy` 状态 / inspect | 不新增 DB 表 |
| D7 | 静态根 | 默认会话目录下 `public/`，可覆盖 | 无鉴权时避免暴露工作区根 |
| D8 | host command | 沙箱开启时不允许 | 避免绕过 L1 沙箱 |
| D9 | 预览寿命 | 活跃预览挡回收 + 8h TTL | 防资源泄漏 |
| D10 | 开启方式 | 用户在工作区页手动开启；默认关闭；AI 不自动开启 | 避免误暴露；访问由用户明确开启 |

### 2.15 生产化（后续）

本地阶段先把“工作区 → 端口 → URL”跑通。等有域名 / TLS / 统一入口需求时，再在当前 origin 上加一层：

- wildcard 子域名（每个工作区一个，命名后续定）；
- Kong（或现有 ingress）按 Host 反代到工作区端口；
- 预览令牌 / 登录鉴权；
- k8s 的 Service / Ingress。

这些不改变本设计的核心：每个工作区仍然是一个独立的 HTTP origin（端口），只是外面多一层稳定地址。届时再单独评审。

### 2.16 后续待定

1. host command 是否做成沙箱内 + network allow 的长驻进程。
2. 预览 TTL 默认 8h；是否需要访问续期。
3. 静态根默认会话目录下 `public/`；`root` 覆盖的风险提示放在哪一层。
4. 一工作区多服务的端口方案（端口段 / 应用聚合）的排期。
5. 生产化的域名 / Kong / TLS / 鉴权排期。
6. `serve` 的预装策略（工作区镜像 / workspace-service 镜像 / 首次安装）与断网处理。
7. Windows host 的进程组 / `serve` 路径 / 端口探测验证。
8. 面板里的命令 / 静态根配置是否需要持久化（v1 默认不落库；刷新后重新填）。
9. AI 通过 `bash` 起常驻服务如何约束（提示词之外，是否要额外的命令拦截 / 端口白名单）。

### 2.17 实施计划与工作量

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| P0 | workspace-service 预览管理器：static host/container、端口发布 / inspect 恢复、进程、就绪、日志、注册表、内部 API | 5–7 天 |
| P1 | main 控制面 API + SDK + admin 工作区页「预览」面板（手动开启 / 关闭、URL、日志） | 3–5 天 |
| P2 | command（NestJS）+ WebSocket + 就绪 / 日志的 command 分支 | 3–5 天 |
| P3 | 提示词 + timeline 状态提示（未开启 / 已开启 / URL） | 2–3 天 |
| P4 | 生产化：域名 / Kong / 鉴权 / 多服务 / k8s | 另算 |

MVP（P0–P3）约 **2 周**；P4 不在本期。

## 3. 附：与已有能力的关系

- **`ai_files` / `workspace-content`**：仍是“保存下来的文件”和单文件预览；不替代预览服务。图片在 timeline 里的直接显示可以继续用 `workspace-content` / `workspace-link`，不需要为一张图起 `serve`。
- **`workspace-link`**：把工作区文件物化到 OSS 预览；预览服务是“整个 origin”，两者互补。
- **`html-page` 技能**：单文件 HTML 的沙箱预览继续保留；多文件站点走预览服务。
- **`bash`**：仍是短命令 / 构建 / 测试；常驻服务由工作区页「预览」面板启动，不使用 `bash` 起 `serve` 或 `pnpm start`。
