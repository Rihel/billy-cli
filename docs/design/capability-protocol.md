# 能力接入协议 v1（草案）

> 状态：**草案，待评审**（2026-11-18）。只回答「内部服务如何把能力交给 AI 调用」，不含实现。
> 设计背景、取舍与被否掉的方案见 [capability-gateway.md](capability-gateway.md)。
> 本文按 §0 的取值写成；要改规则先改 §0，再改正文，避免正文与结论打架。

## 0. 已定取值

| 项 | 取值 | 备选 | 理由 |
| --- | --- | --- | --- |
| 能力标识 | **扁平工具名**（`xxx-xxx`），全局唯一 | `服务名/工具名` | 服务是工具的分组（1:N）；key 不再拼服务名，模型面与 key 一致 |
| 模型面名字 | 与 key 相同 | `服务名__工具名` | 扁平 key 本身满足 provider 字符集，不需要再派生 |
| 响应体 | 裸 JSON（HTTP 200 + outcome） | `{ code, data }` 信封 | 外部团队接入不必理解我们的信封 |
| 调用端点 | 固定 `POST /invoke` | manifest 里声明路径 | 少一个配置项，少一类「接不通」 |
| 接口风格 | **一律 `POST` + JSON body，不用路径参数**（`service` / `instanceId` / `taskId` 全放 body） | `/v1/services/{service}` 这类 REST 风格 | 仓库规范：业务路由全 POST；路径参数在拼接、转义、日志里都是额外风险 |
| 探针例外 | `GET /healthz` / `GET /readyz` | 也用 POST | k8s / 负载均衡的探针只会发 GET |
| 能力定义位置 | **在服务自己的代码里，用 zod 写**（装饰器只是内部便利写法） | 集中写在 `pkg` | 定义与实现同处，改一处就够；pkg 只放机制，不放具体能力（§5.1） |
| 默认执行形态 | `mode: sync` | 默认 task | 挡住「所有服务都做成异步」的过度设计 |
| 登记方式 | 代码声明（构建期收集）+ 后台表单填写 | 只支持内部服务 | 外部团队不在我们集群内，不可能跑我们的构建；两条路径终点相同 |
| 网关名 | `capability-gateway`（能力网关） | `tool-gateway` | 已定（2026-11-18）；代码标识随阶段 1–2 一起改 |
| 通用能力服务名 | `common-capability`（原 `tool-worker`） | 保留 `tool-worker` | 只跑 `exec` / `web`；服务名与进程名是两回事，见 §2.1 |

## 1. 定位与边界

**包含**：服务与网关的定义、命名规则、服务声明、能力声明、调用、同步结果、异步任务、长耗时执行、回调、幂等、分页、凭据注入。

**不包含**：

- 注册 / 心跳 / 服务发现 —— 部署解决（地址由部署给）；
- 限流 / 配额 / 审计 / 脱敏 —— 网关做，服务不实现；
- 密钥存储 —— 网关注入，服务不持有；
- 流式进度、人工介入、工具检索 —— 见 §19。

## 2. 服务与网关

### 2.1 什么是服务

**一个服务 = 一组能力 + 一个 owner + 一条数据与权限边界。**

它**通常**对应一个部署单元，但两者不是一回事：一个进程可以先承载多个服务身份（各自一份 manifest），只要每个服务自己的边界清楚；将来规模上来再按服务拆进程。

判断标准（满足多数才算）：

| 判据 | 说明 |
| --- | --- |
| 有明确的 owner | 出问题知道找谁 |
| 可独立拆出部署 | 想拆的时候能单独拆出去：有自己的端点与配置，不依赖别的服务的进程内状态 |
| 自己的数据与权限边界 | 它的能力读写哪些表、能访问哪些网络，边界清楚 |
| 能力同源 | 一组能力做同一类事：同一业务域，或同一类执行 |
| 独立生命周期 | 它升级不该拖着别人一起发版 |

反例（都很容易误当成服务）：

- **一个工具不是服务**：`send` 是能力，`notify` 才是服务——一个服务可以有很多工具（1:N）；
- **一个装全部执行器的进程不是服务**：现在的 `tool-worker` 同时跑沙箱命令、出网抓取、直连数据库，是三份不同安全边界堆在一起；
- **BFF / 控制面不是服务**：`main` 面向客户端与后台，不是「某个能力域的拥有者」；
- **编排原语不是服务**：`plan/*`、`agent/*` 需要 run 状态与客户端交互，留在 `agent-runtime`，不登记。

### 2.2 什么是网关

**网关 = 能力的唯一入口与唯一目录持有者。**

它做四件事：

1. **收登记**：接收「服务名 + 能力清单」——可以来自代码声明，也可以在后台表单里填（见 §4.1）——校验后落目录；
2. **组装目录**：把服务登记的工具做成能力目录（key 就是工具名），按身份过滤后交给上游；
3. **治理**：鉴权、scope、限额、幂等、脱敏、审计、分页；
4. **拆名字并路由**：拿到一次调用后拆成「服务名 + 工具名」，按服务名找端点转发。

它**不做**：不执行能力、不拥有业务数据、不做心跳探测与服务发现、不当业务状态的第二份真相。

### 2.3 分工

| | 服务 | 网关 |
| --- | --- | --- |
| 声明 | 我叫什么、我有哪些工具、参数长什么样、怎么执行 | 汇总、校验、拼 key、按身份过滤 |
| 调用 | 收到请求就执行，返回结果或受理 | 拆 key、路由、超时、重试、分页、翻译错误 |
| 异步 | 生成任务 id、维护任务状态、给出终态 | 存索引、轮询、去重回调、GC |
| 治理 | **不做** | 鉴权、scope、限额、幂等、脱敏、审计 |
| 凭据 | 不持有第三方密钥 | 调用前注入 |
| 发现 | 不知道网关存在 | 部署时就知道服务地址 |

### 2.4 一条硬边界

服务声明「服务名 + 每条能力的工具名」；**能力 key 就是工具名本身**（`xxx-xxx`），
网关用它做全局索引路由到服务。服务是「一组工具」的登记单位（1:N），不参与 key 的拼接。

## 3. 命名规则

### 3.1 两个名字

| 名字 | 示例 | 谁产生 | 用在哪 |
| --- | --- | --- | --- |
| **服务名** | `common-capability` | 服务注册时声明，全局唯一 | 分组、部署、审计归属、凭据 |
| **能力 key = 工具名** | `file-list` | 服务声明，**全局唯一** | 目录、调用、审计、时间线 |

模型面名字与 key 相同——扁平形式（`a-z0-9-`）本来就被 OpenAI / Anthropic 接受，不需要再派生。

### 3.2 唯一性

- 服务名全局唯一；
- **工具名全局唯一**（因为 key 就是它）：登记时跨服务查重，冲突直接拒绝（409），不加自动后缀；
- 服务内工具名自然也不重复（上面一条的子集）。

### 3.3 路由

```
登记：  service=files  +  tool=file-list   →  目录项 key=file-list（记下它属于 files）
调用：  key=file-list  →  网关查 key → 服务索引  →  找到 files → 选实例 → 把 file-list 交给它
```

- 服务侧的 `/invoke` 只看到工具名；
- 模型侧看到的就是 key，不需要映射；
- 库里、审计里、时间线里存的也是 key。

### 3.4 字符规则

| 规则 | 值 |
| --- | --- |
| 服务名 | `[a-z0-9][a-z0-9-]*`，≤ 24 |
| 工具名（key） | `[a-z0-9][a-z0-9-]*`，≤ 60（`ai_tools.tool_key` 是 varchar(64)） |
| 禁止 | `__`、`/`、空格、中文、大写 |
| 模型面 | 与 key 相同，≤ 64 |

### 3.5 为什么不再带服务前缀

早先设计过 `服务名/工具名` + 模型面 `服务名__工具名` 两层映射。实测结果是**同一个能力出现了两个名字**：
登记、审计、模型面各一套，加能力时要同步多处。现在：

- 内置能力的工具名（`bash`、`file-list`、`memory-save`…）本来就全局唯一，直接当 key；
- 外部团队的工具名要求全局唯一，建议自带业务前缀（如 `order-create`），冲突在登记时暴露；
- 模型面直接用 key，`/` 与 `__` 的兼容问题自然消失。

### 3.6 预留

`gateway`（网关内建：取结果、等任务、取消任务）作为工具名保留前缀；`plan-*`、`agent-*` 是编排原语，
不登记、由 runtime 本地执行。

### 3.7 外部来源

| 来源 | 登记方式 |
| --- | --- |
| 内部服务 | 代码声明 + 启动注册（`source:'code'`） |
| 外部团队 | 后台表单登记（`source:'manual'`）+ 自有工具名 |
| 外部 MCP / 连接器 | 由网关做适配后以 `manual` 登记，工具名冲突直接拒绝 |

### 3.8 改名

**工具名一旦登记不可变。** 真要改 = 新工具名 + 旧名标 `deprecated` 保留一个发布周期（时间线还引用它）。

## 4. 服务声明

```json
{
  "protocolVersion": 1,
  "service": "notify",
  "title": "通知服务",
  "description": "站内、飞书、邮件三个通道",
  "owner": "消息组",
  "baseUrl": "http://notify:8080",
  "healthPath": "/healthz",
  "auth": { "mode": "service-token", "header": "authorization" },
  "capabilities": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `protocolVersion` | 是 | 整数，当前 `1` |
| `service` | 是 | 服务名，全局唯一；服务是「一组工具」（1:N），字符规则见 §3.4 |
| `title` | 是 | ≤ 64 |
| `description` | 否 | 后台页面展示的服务说明 |
| `owner` | 是 | 出问题找谁（人或群） |
| `baseUrl` | 外部必填 | 网关调用地址；**内部服务不填**，由实例注册给（§4.6）；默认 https，联调可勾选 http |
| `healthPath` | 否 | 默认 `/healthz` |
| `auth.mode` | 是 | `none` / `service-token` / `gateway-injected` |
| `auth.header` | 否 | 默认 `authorization` |
| `capabilities` | 是 | 至少一条 |

### 4.1 登记的两条路径

| 路径 | 适合 | 能力清单从哪来 | 谁维护 | 事实源 |
| --- | --- | --- | --- | --- |
| 代码声明（构建期收集） | 我们 monorepo 里的服务 | 代码里的声明 | 服务 owner + 发布流程 | 代码，构建期写入网关 |
| 后台登记（表单） | 外部团队、不在我们集群内的服务 | 后台逐条填 / 交一份 JSON 清单 / 可选 `POST /manifest` 拉取（见 §4.3） | 平台管理员 + 对方 owner | 网关里的登记记录 |

两条路径的**终点相同**：网关里一条服务记录 + 若干能力。之后的目录、治理、路由完全一致，AI 侧看不出区别。

**登记是一次性声明，不是持续心跳**（健康由网关每 30 秒主动探活，见 §4.3）。服务不向网关报活；这也是为什么外部团队只要填一次信息就能被调用。

### 4.2 后台登记要填什么

| 字段 | 说明 |
| --- | --- |
| 服务名 | 全局唯一，登记后不可改；要改 = 新服务 + 别名 |
| 标题 / 说明 / owner | 展示与追责（对方团队、联系人） |
| baseUrl | 对方服务地址；默认 https，联调可勾选允许 http（会标记为不安全） |
| healthPath | 默认 `/healthz`，用于「测试连通」 |
| 鉴权 | header 名 + 密钥值；密钥单独保存，页面只回提示串 |
| 调用路径 | 固定 `POST /invoke`（对方在自己服务里挂一个路由即可） |
| 能力清单 | 后台逐条填 / 导入 JSON / 可选拉 `POST /manifest` |
| 出口 | 走公共出口还是专线 / VPN（见 §4.4） |

表单必须提供两项自检：**测试连通**（`GET {healthPath}` 返回 200）与**冒烟调用**（用示例入参发一次 `invoke`），两项都过才允许启用（细则见 §4.3 末）。

### 4.3 接入的最小实现要求

外部团队不需要引 SDK，也不需要实现 MCP——**在现有 API 服务上挂一个路由**就够了。这个路由只做四件事：验令牌、按 `tool` 分发、执行、回一个 JSON。

```
POST {baseUrl}/invoke
content-type: application/json
x-internal-token: <网关发给对方的令牌>
```

```json
// 请求（网关发来）
{
  "version": 1,
  "requestId": "req-01J8Z9",
  "tool": "create",
  "input": { "sku": "A-1", "count": 2 },
  "reason": "用户要下单",
  "caller": { "userId": "u-1", "isAdmin": false, "agentKey": "assistant", "depth": 0, "conversationId": "c-1", "runId": "run-1" },
  "deadlineMs": 15000,
  "idempotencyKey": "run-1:call-7"
}
```

```json
// 响应（两种之一）
{ "version": 1, "ok": true, "data": { "orderId": "ord-8891" } }
{ "version": 1, "ok": false, "reason": "sku-unavailable", "message": "库存不足" }
```

声明的能力是 `mode:"task"` 的，再加两个路由（**同样是 POST，taskId 放 body**）：

```
POST {baseUrl}/tasks/get      { "taskId": "cmd-01J8", "waitMs": 30000 }
POST {baseUrl}/tasks/cancel   { "taskId": "cmd-01J8" }
```

**没有**：初始化握手、协议版本协商、会话 id、SSE、JSON-RPC、能力协商。也**不要求**对方改造成 MCP 服务，或提供 OpenAPI 让我们自动映射——那两种都比上面这 30 行重。

最小实现长这样（Node，约 25 行；Java / Go / Python 等价）：

```js
// 跑在对方现有服务里，不引入任何我们的包
app.post('/invoke', (req, res) => {
  if (req.header('x-internal-token') !== process.env.BILLY_TOKEN)
    return res.status(403).json({ version: 1, ok: false, reason: 'denied', message: '令牌不匹配' })

  const { version, requestId, tool, input } = req.body
  const reply = (outcome) => res.json({ version, requestId, ...outcome })

  switch (tool) {
    case 'create':
      return createOrder(input)
        .then((order) => reply({ ok: true, data: { orderId: order.id } }))
        .catch((err) => reply({ ok: false, reason: 'create-failed', message: err.message }))
    case 'status':
      return getOrder(input.orderId).then((order) =>
        order ? reply({ ok: true, data: order })
              : reply({ ok: false, reason: 'not-found', message: '订单不存在' }))
    default:
      return reply({ ok: false, reason: 'unknown-tool', message: `不认识的工具：${tool}` })
  }
})
```

#### 能力清单怎么给（从轻到重）

| 方式 | 做法 | 适合 |
| --- | --- | --- |
| 后台逐条填 | 表单里填 `tool` / `title` / `description` / `inputSchema` | 工具一两个 |
| 交一份 JSON 清单 | 按 §4 + §5 的同形 JSON 一次导入 | 工具较多、有发布流程 |
| `POST {baseUrl}/manifest` | 对方返回同一份 JSON，后台点「拉取」 | 长期维护，清单随代码走 |

清单里最少要填 `tool` / `title` / `description`。`inputSchema` 建议填——**不填则网关不校验入参**，模型传错只能由对方兜底。

**推荐用 `POST {baseUrl}/manifest`**：清单跟对方代码一起版本化，后台点一次「拉取」就同步，不用手抄 schema，也不会出现「后台填的和实际实现不一致」。

**外部服务靠探活**：网关每 30 秒 `GET {baseUrl}{healthPath}`（默认 `/healthz`；**探针是唯一允许 GET 的地方**，不带路径参数），3 秒超时、不跟随重定向；连续 3 次失败把 `available` 置 false（目录保留、调用报 `no-provider`），连续 2 次成功自动恢复。对方不需要多实现一个上报端点——「有人定时来敲门」和「主动报活」在判断服务活着这件事上等价，而前者对外部团队是零成本。内部服务不探活，靠实例心跳（§4.6）。

没有 `/healthz` 的服务（外部团队常见）把 `healthPath` 留空：网关不探活，`available` 由最近一次调用结果兜底——成功即 up；失败置 down，60 秒冷却后允许再调。

#### 和 MCP 比，差在哪

| | MCP 服务 | 我们的协议 |
| --- | --- | --- |
| 传输 | JSON-RPC 2.0（stdio 或 HTTP + SSE） | 普通 `POST /invoke`，JSON |
| 握手 | `initialize` + 协议版本 + capabilities | 无 |
| 会话 | 有 session id | 无 |
| 能力发现 | 协议方法 `tools/list` | 后台表单 / JSON 清单 / 可选 `/manifest` |
| 错误 | JSON-RPC 错误码 + `isError` | HTTP 状态码 + `ok:false` + `reason` |
| 依赖 | 通常要引 MCP SDK | 任意语言，一个路由 |
| 工作量 | 半天到两天 | 约 30 行 |

如果对方**已经**是现成的 MCP 服务（第三方生态），网关也可以按 MCP 客户端去接（§18）——但这不是我们对外部团队的要求。

#### 登记前必须过的两项自检

1. **测试连通**：`GET {healthPath}` 返回 200；
2. **冒烟调用**：挑一个能力，用后台填的示例入参发一次 `invoke`，返回 `ok:true`，或返回一个能解释原因的 `ok:false`。

两项都过，才允许 `draft → active`（§4.5）。

### 4.4 外部服务的网络与安全

外部服务不在我们集群内，网关要主动出网调它，必须满足：

1. **默认 https**；联调 / 内网可以先开 http，但要在登记记录里显式勾选「允许 http」，并在目录、审计与日志里标记为不安全来源；
2. **baseUrl 防 SSRF**：解析后的 IP 不得落在回环、链路本地、云元数据地址段；每次调用重新校验（防 DNS rebinding）；
3. **出口受控**：按登记时选的出口走，不允许任意目标；
4. **响应体积上限与超时**强制生效（默认 15s），避免被对方拖死；
5. **默认不支持回调**：对方要回调我们，需要公网入口与单独评审（见 §11）。

### 4.5 状态与生效

| 状态 | 含义 | AI 能看到吗 |
| --- | --- | --- |
| `draft` | 已填、未测通或待审核 | 否 |
| `active` | 已测通并启用 | 是（受 scope / 开关约束） |
| `disabled` | 人工停用（对方下线、安全问题） | 否 |

- `draft → active` 必须**至少一次测试连通成功**；
- 改 `baseUrl` / 鉴权 / 能力清单后自动回到 `draft`，需重新测试；
- **探活 / 心跳失败只把 `available` 置 false**，目录保留、调用报 `no-provider`，不自动回到 `draft`、不自动下线；
- 变更留版本（谁改的、改了什么），因为改 `description` / `inputSchema` 会直接改变模型行为。

### 4.6 内部服务：按负载选实例

内部服务可以多副本，路由就一句话：**哪个实例负载低就去哪个**。

| | 内部（`source=code`） | 外部（`source=manual`） |
| --- | --- | --- |
| 地址 | 多个实例，随时增减 | 一个 `baseUrl` |
| 负载均衡 | **网关做**，按负载比选 | 不做 |
| 存活判断 | **实例心跳**（10s，30s 失联） | 网关 30s 探活 |
| 能力清单 | 代码声明 | 表单 / JSON / `POST /manifest` |

一个服务对应多个实例，能力挂在**服务**上，不挂在实例上：

```
exec                              ← service（一组工具，服务名全局唯一）
├── cc-7d9f   http://10.0.1.7:9994   active 3/32
├── cc-2a11   http://10.0.1.8:9994   active 1/32
└── cc-9c02   http://10.0.1.9:9994   draining
```

`instanceId` 只需在**同一服务内**唯一（建议 `hostname:pid` 或 k8s pod 名）。

#### 4.6.1 心跳

```
POST /v1/instances/heartbeat
{ "service": "exec", "instanceId": "cc-7d9f", "active": 3 }

POST /v1/instances/deregister
{ "service": "exec", "instanceId": "cc-7d9f" }
```

- 心跳只报「我还活着」和「我在跑几个」；地址与并发上限在 register 里给过；
- 10 秒一次，30 秒没有就失联，**不再单独探活**；
- 网关返回 `unknown-instance`（比如它重启后实例表空了）时，SDK 自动重发一次 `POST /v1/services/register`；
- `POST /v1/instances/deregister` = 摘流量（不再派新请求）；在跑的任务靠 `taskId → 实例` 映射仍能查到，进程退出后标 `lost`；
- 进程被 `kill -9` 没来得及调 deregister 也没关系——心跳过期自动摘；
- **不报能力**——能力由声明给。所以这是「实例池」，不是「注册中心」。

#### 4.6.2 怎么选

1. 过滤：失联、`draining`；
2. 选 `active / maxConcurrency` 最低的那个；一样低就随机，避免都打同一台；
3. 连不上或 5xx：换一个实例重试（只对幂等能力或没送达的请求）；
4. 不做 zone、weight、在途计数——等真有跨可用区或负载明显倾斜再加。

#### 4.6.3 任务多一行映射

同步调用不留状态。只有 `mode:"task"` 的调用成功后才多一行：网关记 `taskId → 实例`（Redis，TTL = 任务寿命），`wait` / `cancel` 按它回到原实例——否则轮询可能落到没有这个任务的实例上。

命令类任务（`exec/bash`）必须记。服务若把任务状态放共享存储、任意实例可查，这一行也可以不要。

#### 4.6.4 外部服务

只有一个地址，网关不拆实例、不做 LB，多实例由对方的 LB 吸收。对方要自己保证：任务状态与幂等键共享存储（否则查询 / 取消 / 重试会落到没有该任务的实例上）、健康检查只代表入口。

### 4.7 登记接口（两条路径共用一个）

```
POST /v1/services/register
x-internal-token: <内部令牌>
{
  "service": "exec",
  "title": "通用能力",
  "owner": "平台组",
  "instance": { "instanceId": "cc-7d9f", "endpoint": "http://10.0.1.7:9994", "maxConcurrency": 32 },
  "capabilities": [ … ]
}
```

- `service` 全局唯一；**同一个服务可以有多个实例，`instanceId` 只需在服务内唯一**；
- `instance` 只有内部服务带；外部服务没有实例概念，由后台填一个 `baseUrl`。

| 谁调 | 什么时候 | 带什么 |
| --- | --- | --- |
| 内部服务的**每个实例** | 进程启动时一次 | 服务声明 + 能力清单 + 自己的 `instance` |
| main 的后台 API | 管理员提交表单时 | 同样的 body + `baseUrl` / 鉴权 / 出口（外部模式） |

**网关是这些登记的唯写方**；后台页只读网关的目录。`ai_tools` 里的开关 / 限额 / 配置 / 密钥仍由 main 写、网关读，分工不变。

**生命周期**

| 时机 | 调用 | 说明 |
| --- | --- | --- |
| 启动（每个实例） | `POST /v1/services/register` | 全量清单 + 自己的 `instance`；幂等，多实例重复提交无副作用 |
| 运行中 | `POST /v1/instances/heartbeat` 每 10 秒 | 心跳即注册 |
| 优雅停机 | `POST /v1/instances/deregister` | 摘流量；在跑任务仍可达 |
| 服务退役 | `POST /v1/services/deregister` | 能力全部转 `deprecated`，实例一并清掉 |

**容错**：启动时网关不可用 → 指数退避重试，**不阻塞服务启动**（服务先跑起来，网关恢复后自动补登记）；网关重启 → 服务与能力在 DB 不丢，实例列表靠心跳自动重建。

**行为**：

- **全量覆盖**：body 就是这一版完整的能力清单；不在清单里的能力转 `deprecated`——**保留配置行，不物理删除**（时间线还引用它）；
- **幂等**：内容没变 = no-op，不产生新版本；
- **diff 留痕**：返回 `{ added, changed, removed }`，并留一条版本记录（谁提交的、代码版本）；
- **校验**：key 前缀必须等于 `service`；工具名服务内唯一；`inputSchema` 必须能解析；
- **即时生效**：清目录缓存 + 发 `ai.capability.changed`。

**滚动发布的已知窗口**：新版本第一次上报后目录立刻有新能力，但老实例还在跑旧代码，这个窗口里调用新能力可能失败。脚手架期接受；要消除得按「实例支持哪些能力」过滤，本期不做。

## 5. 能力声明

能力里**只写工具名**，不写服务名——服务名在顶层声明了一次，网关负责拼。

```json
{
  "tool": "send",
  "title": "发送通知",
  "description": "给指定用户或群发一条通知。需要指定通道时优先用 channel；没指定就按用户默认通道。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "接收人 id 或群 id" },
      "text": { "type": "string", "description": "通知正文，纯文本" },
      "channel": { "type": "string", "enum": ["lark", "email"] }
    },
    "required": ["to", "text"],
    "additionalProperties": false
  },
  "risk": "write",
  "idempotent": false,
  "scope": "user",
  "timeoutMs": 15000,
  "pagination": "none",
  "tags": ["通知", "消息"],
  "execution": { "mode": "sync" }
}
```

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tool` | 是 | — | 工具名，**服务内唯一**；语义变了要换新工具名 |
| `title` | 是 | — | ≤ 64 |
| `description` | 是 | — | **给模型看**，≤ 900；写清何时用 / 何时不用 / 约束 |
| `inputSchema` | 是 | — | JSON Schema 2020-12，顶层必须是 `object` |
| `risk` | 否 | `read` | `read` / `write`；`write` 可由策略要求管理员或会话内确认 |
| `idempotent` | 否 | `false` | 决定网关能否重试 |
| `scope` | 否 | `all` | `all` / `user` / `admin` / `agent` |
| `allowedAgents` | 否 | — | `scope=agent` 时必填 |
| `timeoutMs` | 否 | `30000` | 服务侧单次执行上限，**仅 sync** |
| `pagination` | 否 | `none` | `none` / `cursor` |
| `tags` | 否 | `[]` | 展示与将来检索用，v1 不参与选路 |
| `execution` | 否 | `{"mode":"sync"}` | 见 §6 |

`description` 与 `inputSchema` 是协议里唯一直接影响模型行为的字段，其余都是治理输入。

开关（`enabled`）、限额（`limits`）、工具配置（`config`）、密钥（`secrets`）属于**网关侧的管理配置**，不写进服务声明——服务只声明"我要什么默认值"，实际生效值由网关按服务与工具两层配置下发。怎么存、怎么覆盖见设计稿 §6.3。

### 5.1 定义写在哪：服务内部，用 zod

**定义留在服务自己的代码里，`pkg` 里只放机制、不放定义。**

```ts
// common-capability/src/tools/bash.tool.ts
const BashInput = z.object({
  command: z.string().min(1).max(2000).describe('要执行的整条命令行'),
  cwd: z.string().optional().describe('工作目录；不允许跑到工作目录之外'),
})

@CapabilityGroup({ service: 'exec' })
export class BashTool {
  @CapabilityDecl({
    tool: 'bash',
    title: '执行 bash 命令',
    description: '……',
    input: BashInput,
    risk: 'write',
    execution: {
      mode: 'task', owner: 'session', yieldMs: 45_000,
      wait: { maxWaitMs: 60_000 }, cancel: 'supported', maxRunMs: 1_800_000,
    },
  })
  async run(input: z.infer<typeof BashInput>, ctx: CapabilityCtx) { … }
}
```

- **定义与实现同文件**：改参数时不会漏改另一处；
- 共享包里只有四样东西：装饰器、扫描器（把已声明的能力收集成 manifest）、转换（zod → JSON Schema）、注册客户端；**没有任何具体能力**；
- 装饰器只是我们内部的便利写法，**不是协议的一部分**——外部服务实现 `/invoke` 就行（§4.3），不用装我们的包。

**转换**：`z.toJSONSchema(input, { target: 'draft-2020-12' })` 写进 manifest 的 `inputSchema`；`.describe()` 自动变成字段说明，也就是模型真正读到的那些字。

**`reason`**：由网关在调用前从入参里摘出、提升为 `invoke.reason`，服务收到的 `input` 里没有它。

**`@repo/tool-catalog` 不再承载定义**：它的 32 条要么搬进各自服务，要么只留一份构建期快照供 review（不作为注册来源）；`pnpm gen:tool-catalog` 随之退役或改成校验脚本。

**声明了但不注册**：编排原语（`plan/*`、`agent/*`）用同一套装饰器声明，注册时跳过（不进网关目录）。

## 6. 执行声明

```json
"execution": {
  "mode": "task",
  "owner": "session",
  "yieldMs": 45000,
  "wait": { "maxWaitMs": 60000 },
  "cancel": "supported",
  "poll": { "minIntervalMs": 1000 },
  "maxRunMs": 1800000,
  "callback": { "supported": true }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `sync` | `sync`（调用内拿到结果）/ `task`（受理后取结果） |
| `owner` | `session` | `session` / `user` / `tenant`，**仅 task**；决定任务归属与生命周期 |
| `yieldMs` | `45000` | 调用时最多同步等多久；`0` = 立即返回 task |
| `wait.maxWaitMs` | `0` | 查询接口可阻塞等待的上限；不填 = 不支持长轮询 |
| `cancel` | `none` | `supported` / `none` |
| `poll.minIntervalMs` | `1000` | 客户端最小轮询间隔 |
| `maxRunMs` | `1800000` | 任务总寿命，到期服务标 `failed(timeout)` |
| `callback.supported` | `false` | 是否支持网关回调；外部服务默认 `false` |

### 6.1 三种执行形态

| 形态 | 声明 | 例子 | 之后怎么拿结果 |
| --- | --- | --- | --- |
| 纯同步 | `{ "mode": "sync" }` | 查订单、发通知 | 调用返回即结果 |
| 受理即完成 | `{ "mode": "sync" }` + `data` 带业务 id | 下单、提工单 | 另开一个能力查状态（如 `order/status`） |
| 受理未完成 | `mode:"task"` | 长命令、导出、审批 | 轮询 `POST /tasks/get` 或回调 |

**默认「受理即完成」而不是「受理未完成」**：下单接口返回订单号，业务上这笔交易已经成立；用户过一会儿问「订单到哪了」是再调一次查询能力，不是轮询同一次调用。只有当「结果必须回到当前对话才能继续」时才用 `task`。

### 6.2 task 的两种典型配置

| 场景 | 配置 |
| --- | --- |
| 长耗时命令（install / build / 渲染） | `mode:"task"`, `owner:"session"`, `yieldMs:45000`, `wait.maxWaitMs:60000`, `cancel:"supported"` |
| 业务作业（导出 / 审批 / 等支付） | `mode:"task"`, `owner:"user"`, `yieldMs:0`, `wait.maxWaitMs:0`, `callback.supported:true` |

## 7. 调用

```
POST {baseUrl}/invoke
content-type: application/json
x-internal-token: <服务间令牌>
x-capability-key: file-list       # 能力 key（工具名），仅用于日志与排障；调用逻辑不依赖它
x-capability-config: <JSON，可选，网关注入的配置；服务只读>
```

```json
{
  "version": 1,
  "requestId": "req-01J8Z9",
  "tool": "send",
  "input": { "to": "u-1", "text": "构建失败" },
  "reason": "用户要求构建失败后立刻通知相关人",
  "caller": {
    "userId": "u-1",
    "isAdmin": false,
    "agentKey": "assistant",
    "rootAgentKey": "assistant",
    "conversationId": "c-1",
    "runId": "run-1",
    "workspaceConversationId": "c-1",
    "depth": 0
  },
  "deadlineMs": 15000,
  "idempotencyKey": "run-1:call-7",
  "pagination": { "cursor": "…", "limit": 50 },
  "traceId": "tr-9f2c"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `version` | 是 | 协议版本 |
| `requestId` | 是 | 幂等与排障关联 |
| `tool` | 是 | **工具名 = 能力 key**；网关已经按它路由到本服务 |
| `input` | 是 | 已按 `inputSchema` 校验 |
| `reason` | 是 | 模型为什么调；**从模型入参摘出，不进 `input`** |
| `caller` | 是 | 调用方身份，服务只读、不得回写 |
| `deadlineMs` | 是 | **本次 HTTP 调用**的墙钟上限；服务必须在此之前返回（返回 task 也算返回） |
| `idempotencyKey` | 否 | `idempotent=true` 时网关生成，重试不变 |
| `pagination` | 否 | 仅 `pagination=cursor` |
| `traceId` | 否 | 链路追踪 |

## 8. 响应（三种形态，HTTP 200）

**完成**

```json
{ "version": 1, "ok": true, "data": { "messageId": "m-9" } }
```

**受理**（任务或长命令）

```json
{
  "version": 1,
  "ok": true,
  "task": { "id": "cmd-01J8", "state": "pending", "data": { "running": true }, "pollAfterMs": 2000 }
}
```

**业务失败**

```json
{
  "version": 1,
  "ok": false,
  "reason": "channel-unavailable",
  "message": "飞书通道未配置",
  "hint": "让管理员在通知设置里配置飞书应用",
  "retryable": true
}
```

分页时在完成形态上带 `nextCursor`。

| 字段 | 说明 |
| --- | --- |
| `ok` | 业务成败；**业务失败也是 HTTP 200** |
| `data` | `ok=true` 且未受理时必有 |
| `task` | 受理时返回；`id` 由**服务**生成 |
| `reason` | kebab-case 稳定标识，不写中文、不改语义 |
| `message` | 给人看 |
| `hint` | 给模型看的下一步建议（可选） |
| `retryable` | 服务声明是否值得重试；网关仍按 `idempotent` 二次把关 |
| `nextCursor` | 分页游标，不透明 |

### 8.1 错误归属

| 谁产生 | 形态 | 例子 |
| --- | --- | --- |
| 服务（业务失败） | HTTP 200 + `ok:false` | `channel-unavailable` |
| 服务（崩溃） | 5xx + `{ error: { code, message } }` | `500 internal` |
| 服务（忙） | 503 + `{ error: { code: "busy" } }` | 并发满了 |
| 网关拒绝 | 直接返回，不调服务 | `denied`、`invalid-input`、`budget-exceeded` |
| 网关无可用提供者 | 同上 | `no-provider` |
| 网关超时 | 同上 | `timeout` |

服务**只对业务失败负责**：鉴权、scope、限额、参数不合法都在网关拦掉，服务不会收到。

## 9. 任务查询与取消

```
POST {baseUrl}/tasks/get      { "taskId": "cmd-01J8", "waitMs": 30000 }   // waitMs 仅 wait.maxWaitMs > 0
POST {baseUrl}/tasks/cancel   { "taskId": "cmd-01J8" }
```

```json
{
  "version": 1,
  "id": "cmd-01J8",
  "state": "running",
  "data": { "exitCode": null, "outputTail": "…最后 4KB…", "elapsedMs": 45000 },
  "progress": { "percent": 40, "message": "已抓取 4/10 个页面" },
  "result": { "ok": true, "data": { "exitCode": 0, "output": "…", "truncated": true } },
  "error": { "reason": "…", "message": "…" },
  "nextCursor": "…"
}
```

**状态固定六种**：`pending` / `running` / `succeeded` / `failed` / `canceled` / `expired`。

**状态分两层**：`state` 是协议固定的执行状态，网关只关心「结束了没有」；业务状态放 `data`（如订单的 `paid`），网关原样透传、不解释。否则「已支付」和「运行中」会打架。

**取消**：幂等。已进入终态时返回当前快照，不报错。取消的含义由服务定义（杀进程 / 撤单 / 停止导出）。

**级联取消**：一轮对话被停止时，网关级联取消**该轮发起的、`owner=session` 的任务**（命令、渲染这类随会话存在的执行）。`owner=user` / `tenant` 的任务只解除等待、不取消——业务动作不能因为关掉对话就回滚，要取消得走显式操作。

**过期**：`result` 保留 `resultTtlMs`（服务声明，默认 7 天），过期后 `state=expired`，查询不报错。

**完成后唤醒**：任务进入终态时网关发出事件，agent-runtime 据此唤醒发起它的会话（新起一轮，把结果作为上下文）。用户不在线时只落时间线，等下次进来再消费——唤醒不等于必须立刻调模型。

## 10. 长耗时命令的约定

这不是新协议，是 `task` 的一种用法约定，目的是让模型看到可预期的东西。

**受理时的 `task.data`**

```json
{
  "commandId": "cmd-01J8",
  "running": true,
  "exitCode": null,
  "outputTail": "…",
  "logRef": "workspace:.billy/logs/cmd-01J8.log",
  "elapsedMs": 45000
}
```

**终态的 `result.data`**

```json
{ "exitCode": 0, "output": "…", "logRef": "…", "truncated": true, "durationMs": 613000 }
```

四条硬约束：

1. **输出必须落日志文件，只回 tail**。`pnpm install` 能刷几千行，全塞进内存或网关请求会打死进程；
2. **命令跑在会话前台，不要 `nohup` / `setsid` / `&`**。一旦脱离就追踪不到输出和退出码；
3. **沙箱 / 工作区生命周期必须覆盖命令生命周期**。worker 重启 = 命令丢失，此时状态必须报 `lost`，不能假装还在跑；
4. **后台命令不占 HTTP 并发槽，但要单独限「同时运行命令数」**。否则一个用户开 20 个 build 就能打爆一台机器。

### 10.1 模型侧两个内建工具

网关提供，不属于任何服务的能力清单：

- `gateway/wait-task({ taskId, waitMs })`：长轮询，未结束返回当前快照 + `running: true`；
- `gateway/cancel-task({ taskId })`：幂等取消。

对命令和业务任务通用。

### 10.2 时间线合并

同一个 `taskId` 的多次 `wait-task` 在时间线上**合成一张卡片**，显示最新输出与状态。否则一次 build 会刷出二十多张卡，会话变成日志流。

## 11. 回调

```
POST {gateway}/v1/tasks/callback
x-internal-token: <服务令牌>
x-callback-signature: HMAC(service, eventId + occurredAt + body)
```

```json
{
  "version": 1,
  "taskId": "ord-8891",
  "eventId": "evt-3f2a",
  "state": "succeeded",
  "data": { "orderStatus": "paid" },
  "occurredAt": "2026-11-18T00:10:00Z"
}
```

五条铁律：

1. **回调打给网关，不打给调用方**。绕开网关等于绕过治理、审计与幂等；
2. **回调地址由网关生成**，URL 内嵌不透明 token 绑死 taskId，不接受调用方传入；
3. **必须带 `eventId`**，网关去重；**必须带 `occurredAt`**，只进不退（终态不能被旧事件改回）；
4. **轮询是真相，回调只是加速**。回调丢了不能让任务永远挂着；
5. **外部服务默认不支持回调**：要回调我们的网关需要公网入口与出网策略，`callback.supported` 由网关按网络位置决定是否启用。

## 12. 幂等与重试

- `idempotent: true` 的能力才允许重试，且**只重试「请求没送达 / 明确没执行」**；
- 重试时 `idempotencyKey` 不变；**任务创建必须返回同一个 taskId**，不能建出两个；
- 网关不重试已执行的操作，即使服务声明了 `retryable`；
- 查询、取消都幂等。

## 13. 三个超时，别混

| 超时 | 谁定 | 管什么 |
| --- | --- | --- |
| `deadlineMs` | 网关 | 单次 HTTP 等待，超出按 `timeout` 处理 |
| `yieldMs` | 服务声明 | 调用时同步等待窗口，超出返回 task（**不是失败**） |
| `maxRunMs` | 服务声明 | 任务总寿命，到期标 `failed(timeout)` 并保留已有输出 |

## 14. 分页

- `pagination: cursor` 的能力返回 `nextCursor`，网关把它变成不透明句柄交给模型；
- 模型后续只回传句柄，看不到游标本体；
- 服务不实现分页也行：网关对超大结果截断并给「取下一页」的引用。

## 15. 凭据

- 服务不读库、不持有第三方密钥；
- 网关按 `auth.mode` 在调用前注入到声明里的 header，并保证不进日志、不进审计；
- **服务级出站凭据 v1 必做**：后台登记外部服务时录入 header 名与密钥值，网关调用前注入；密钥单独存储，页面只回提示串，日志与审计脱敏。没有它，集群外的服务根本调不通；
- 密钥支持轮换：同一服务可同时存在新旧两个值，旧值在保留期内仍被接受，便于对方平滑切换；
- 能力专属配置走 `x-capability-config`（JSON），服务只读；
- 用户级 OAuth **v1 不做**；`caller` 已带身份，将来注入用户 token 不用改协议。

## 16. 版本与兼容

- 只加可选字段**不升版本**；删字段 / 改语义才升；
- 网关同时接受相邻两版，维持一个发布周期；
- 工具名稳定：语义变了换新工具名，旧名标 `deprecated` 并保留（时间线里还有历史引用）；
- `description` / `inputSchema` 可随时改（模型实时读），后台留版本记录。

## 17. 接入一个服务

### 17.1 内部服务（代码声明）

1. 写声明：服务名（全局唯一）+ 每条能力的工具名（**全局唯一**）；monorepo 里写 TS、构建期生成 JSON；
2. 实现 `POST /invoke`：校验 → 执行 → 返回三种形态之一；
3. 声明是 task 的，再实现 `POST /tasks/get` 与 `POST /tasks/cancel`；
4. 声明随构建进网关，在 `ai_tools` 配开关 / scope / 限额；
5. 自测三件事：`curl` 能拿到结果、网关目录里有它、模型工具面里能看到。

### 17.2 外部服务（后台登记）

1. **对方只加一个路由**：`POST /invoke`（task 能力再加两个任务端点），约 30 行，不引 SDK、不做 MCP；
2. 管理员在后台填：服务名、baseUrl、鉴权、出口；
3. 填能力清单（表单 / JSON / 可选拉 `/manifest`），`inputSchema` 建议填；
4. 过两项自检：测试连通 + 冒烟调用，通过后启用（`draft → active`）；
5. 自测同样三件事：能调通、目录里有、模型工具面里能看到。

### 17.3 两条路径的共同点

不管走哪条，服务最终都被归一成「一条服务记录 + 若干能力」，后续治理与路由没有分支。外部服务的能力清单以网关登记记录为准，内部服务以代码为准（构建期覆盖登记记录）。

**多实例的服务**额外自查两条：任务状态与幂等键是否共享存储（否则查询、取消、重试都可能落到「没有这个任务」的实例上，见 §4.6）。

## 18. 与 MCP 的映射

| 本协议 | MCP |
| --- | --- |
| 能力 key（工具名，如 `file-list`） | `tool.name` |
| `description` | `description` |
| `inputSchema` | `inputSchema` |
| `POST /invoke` | `tools/call` |
| `task.id` + `POST /tasks/get` | `tasks/get`（Tasks 扩展） |
| `ok:false` | `isError: true` |
| `nextCursor` | `nextCursor` |

外部 MCP 服务由网关做这层映射：它上报的工具名直接当工具名用，服务名由注册时分配；不要求对方实现本协议。将来要让外部 MCP 客户端调我们，同一层反过来写。

## 19. 明确不在 v1

人工介入（`waiting-input` / 审批）、流式进度、批量调用、用户级 OAuth、多租户配额分摊。

两项明确**先不做**：

- **工具语义检索（`tool_search`）**：现在三十多个工具还能整份下发，先不做；等数量再涨、或者模型开始选不准了再上，协议里的 `tags` 是为它预留的；
- **对外暴露 MCP 端点**：本工程是脚手架，先只服务自家 agent，不把网关做成对外产品。

## 附录 A：现有 32 个工具的新旧对照

表里的「新 key」就是工具名（扁平 `xxx-xxx`）。

| 旧 key | 新 key | 归属 |
| --- | --- | --- |
| `bash` | `exec/bash` | 通用能力服务 |
| `web-fetch` / `web-search` / `web-request` | `web/fetch` / `web/search` / `web/request` | 通用能力服务 |
| `memory-save` / `memory-search` / `memory-forget` | `memory/save` / `memory/search` / `memory/forget` | AI 数据域服务 |
| `append-file` / `read-file` / `replace-file` / `write-file` / `file-list` / `file-search` / `file-submit` / `file-download` / `workspace-files` | `files/append` / `files/read` / `files/replace` / `files/write` / `files/list` / `files/search` / `files/submit` / `files/download` / `files/workspace` | AI 数据域服务 |
| `read-tool-result` | `gateway/read-result` | 网关内建 |
| `skill-list` / `skill-save` / `skill-delete` / `skill-enable` / `skill-import` / `skill-file-save` / `skill-file-append` | `skill/list` / `skill/save` / `skill/delete` / `skill/enable` / `skill/import` / `skill/file-save` / `skill/file-append` | 技能服务（控制面） |
| `plan-create` / `plan-complete` / `plan-delete` / `plan-reorder` | `plan/create` / `plan/complete` / `plan/delete` / `plan/reorder` | 编排原语（不进注册中心） |
| `run-sub-agent` / `cancel-sub-agent` / `sub-agent-list` / `wait-sub-agent` | `agent/run-subagent` / `agent/cancel-subagent` / `agent/list-subagents` / `agent/wait-subagent` | 编排原语（不进注册中心） |

## 附录 B：迁移与别名

改名会断三类历史数据：`ai_tools` 的配置行、时间线里的工具块、审计里的调用记录。

1. （已不需要）key 没改名，别名表已删除；
2. 历史时间线里的 key 原样可读；
3. **`ai_tools` 行就地改名**（唯一索引带软删条件，改名安全），配置跟着走；
4. （已不需要）key 始终保持扁平，没有改名迁移；
5. **提示词 / 技能文档里提到旧工具名的地方一起改**，否则模型会照着旧名字调用。
