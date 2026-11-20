# Kubernetes 部署清单（6 个 Nest 服务）

覆盖六个服务：

- **billy-main**（`apps/main`，容器端口 **9989**）：公网唯一入口 / BFF；HTTP / CRUD + agent SSE 中继（Redis pub/sub）；Deployment / Service / 两份 Ingress / PDB / HPA；
- **billy-agent-runtime**（`apps/agent-runtime`，容器端口 **9990**）：agent loop，只由 main 通过 `AGENT_RUNTIME_URL` 调用；Deployment / ClusterIP Service / 工作区 PVC / HPA，**不接公网 Ingress**；
- **billy-model-gateway**（`apps/model-gateway`，容器端口 **9992**）：模型网关，持有供应商 key、做协议适配；runtime（模型调用）与 main（模型明细同步）调用；
- **billy-capability-gateway**（`apps/capability-gateway`，容器端口 **9993**）：能力网关，能力目录 / 路由 / 审计 / MCP，内建 `wait-task` / `cancel-task` / `tool-search`；runtime（工具面）与 main（后台能力 / 工具配置页）调用；
- **billy-common-capability**（`apps/common-capability`，容器端口 **9994**）：执行服务 `common` 的 9 个能力（`file-submit` / `file-download`、`web-*`、`memory-*`、`read-tool-result`）；启动时向能力网关登记；
- **billy-workspace-service**（`apps/workspace-service`，容器端口 **9995**）：工作区执行面，执行 `bash` + 7 个工作区文件能力，按 ServiceAccount / RBAC 创建 / exec / 删除 `app=billy-workspace` 的 Pod。

后四个只在内网，**不要给它们建 Ingress / NodePort**；web / admin 的部署另议。清单里每个字段「为什么这么取」都写在对应文件的注释里，这里给部署步骤、跨文件的取值不变量，以及上线后的验证方法。每个变量的默认值与必填性见 [docs/guide/env.md](../docs/guide/env.md)。

## 概览与调用链

集群内 DNS 一律是 `<service>.billy.svc.cluster.local`（下面的 `billy-*` 均为 Service 名）：

```
前端 / 管理端
  └─ Ingress（常规 50 + SSE 51）→ billy-main:80 → 容器 9989
       ├─ AGENT_RUNTIME_URL      → billy-agent-runtime:9990（agent loop）
       │    ├─ MODEL_GATEWAY_URL → billy-model-gateway:9992
       │    └─ TOOL_GATEWAY_URL  → billy-capability-gateway:9993
       │         ├─ 服务 common    → billy-common-capability:9994（实例地址 = 各 Pod 的 Pod IP）
       │         ├─ 服务 workspace → billy-workspace-service:9995
       │         │     └─ kubectl 创建 / exec / 删除工作区 Pod（app=billy-workspace，/workspace=emptyDir）
       │         └─ MCP / 外部服务（后台登记，网关出站）
       ├─ TOOL_GATEWAY_URL      → billy-capability-gateway:9993（后台能力 / 工具配置）
       ├─ WORKSPACE_SERVICE_URL → billy-workspace-service:9995（文件页 / 工作区控制）
       └─ MODEL_GATEWAY_URL     → billy-model-gateway:9992（模型明细同步）
```

**AI 流式不经过 Kafka**：runtime 把每一段输出发到 Redis 频道 `agent:stream:client:<clientId>`，
main 的 `AgentSseBridge` 订阅这个**定向频道**后写成前端 SSE（`/agent/chat/stream`、`/agent/run/*`、
`/agent/chat/resume`）。Kafka 是**可选**组件：只有 `KAFKA_BROKERS` 存在时 main / agent-runtime 才装配
`KafkaModule`，当前**没有任何业务生产 / 消费方**，不配不影响任何功能。

## 1. 文件与部署顺序

`k8s/` 共 **24 个 YAML**（另有本 README）：

| 文件 | 内容 |
| --- | --- |
| `00-namespace.yaml` | 命名空间 `billy`（必须最先建） |
| `10-configmap.yaml` | 三份 ConfigMap：`billy-shared`（共用）/ `billy-main` / `billy-agent-runtime` |
| `11-configmap-model-gateway.yaml` | model-gateway 专属 ConfigMap（`PORT=9992`、缓存 TTL、超时、连接池） |
| `12-configmap-capability-gateway.yaml` | capability-gateway 专属 ConfigMap（`PORT=9993`、注册表 freshness、调用上限 / 限流） |
| `13-configmap-common-capability.yaml` | common-capability 专属 ConfigMap（`PORT=9994`、登记 / workspace 地址、心跳、回落工作区根） |
| `14-configmap-workspace-service.yaml` | workspace-service 专属 ConfigMap（`PORT=9995`、登记 / 回调地址、k8s 后端、工作区镜像、回收） |
| `15-pvc-agent-runtime-workspaces.yaml` | runtime 工作区 PVC（**RWX 20Gi**，`storageClassName` 需按集群替换） |
| `16-rbac-workspace-service.yaml` | workspace-service 的 ServiceAccount / Role / RoleBinding（pods get/list/watch/create/delete + `pods/exec`） |
| `20-deployment.yaml` | **main** Deployment（9989；滚动策略 / preStop / 三类探针 / 优雅关闭期限） |
| `21-deployment-agent-runtime.yaml` | **agent-runtime** Deployment（9990，挂工作区 PVC） |
| `22-deployment-model-gateway.yaml` | model-gateway Deployment（9992） |
| `23-deployment-capability-gateway.yaml` | capability-gateway Deployment（9993） |
| `24-deployment-common-capability.yaml` | common-capability Deployment（9994，**1 副本**，原因见文件头注释） |
| `25-deployment-workspace-service.yaml` | workspace-service Deployment（9995，**1 副本**，引用 ServiceAccount，不挂业务 PVC） |
| `30-service.yaml` | main 的 ClusterIP Service（80 → 容器 `http` 9989） |
| `31-service-agent-runtime.yaml` | agent-runtime 的 ClusterIP Service（9990） |
| `32-service-model-gateway.yaml` | model-gateway 的 ClusterIP Service（9992） |
| `33-service-capability-gateway.yaml` | capability-gateway 的 ClusterIP Service（9993） |
| `34-service-common-capability.yaml` | common-capability 的 ClusterIP Service（9994，运维直连 / 排障用） |
| `35-service-workspace-service.yaml` | workspace-service 的 ClusterIP Service（9995） |
| `40-pdb.yaml` | main 的 PodDisruptionBudget（`minAvailable: 2`，只有 main 有 PDB） |
| `50-ingress.yaml` | 常规入口（ingress-nginx）→ `billy-main` |
| `51-ingress-sse.yaml` | SSE 专用入口（`/sse`、`/agent/chat/stream`、`/agent/run`，关缓冲）→ `billy-main` |
| `60-hpa.yaml` | 三份 HPA：`billy-main` 3–8、`billy-agent-runtime` 2–8、`billy-model-gateway` 2–8，CPU 70% |

对象总数与数量口径：

- **6 个 Deployment**：main 3 副本、runtime 2、model-gateway 2、capability-gateway 2、common-capability 1、workspace-service 1；
- **7 份 ConfigMap**：`billy-shared` / `billy-main` / `billy-agent-runtime`（10 号文件 3 份）+ 11–14 号各 1 份；
- **6 个 ClusterIP Service**；**3 份 HPA**；**2 份 Ingress**；**1 个 PDB**；**1 个 PVC**；**1 份 RBAC**（SA + Role + RoleBinding）。

配置拆分与共享：

- 非敏感配置按「共用 / 各服务专属」拆成 ConfigMap，Deployment 用 `envFrom` 依次引用；同一 Pod 的各份键**不重复**，避免覆盖顺序歧义（顺序：`billy-shared` → 各自 ConfigMap → Secret `billy-app`）；
- `billy-shared` 放六个服务都可能用到的公共项（`NODE_ENV` / 对象存储 provider·region·bucket·endpoint / `LOG_LEVEL`）；
- 敏感配置统一放在 Secret **`billy-app`**，所有 Deployment 共用同一份。共用同一份的意义是让「两边必须相同」的令牌天然一致（见 §2、§4）。

```bash
# ① 建命名空间
kubectl apply -f k8s/00-namespace.yaml

# ② 建共享 Secret（键名固定；不要提交真实值）
#    三个随机令牌先落到变量里，再分别写进「必须同值」的键：
MODEL_TOKEN="$(openssl rand -hex 32)"
TOOL_TOKEN="$(openssl rand -hex 32)"
WORKSPACE_TOKEN="$(openssl rand -hex 32)"

kubectl -n billy create secret generic billy-app \
  --from-literal=DB_URL='postgresql://billy:***@postgres.billy.svc.cluster.local:5432/billy' \
  --from-literal=REDIS_URL='redis://:***@redis.billy.svc.cluster.local:6379/0' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=AGENT_INTERNAL_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=MODEL_INTERNAL_TOKEN="$MODEL_TOKEN" \
  --from-literal=MODEL_GATEWAY_TOKEN="$MODEL_TOKEN" \
  --from-literal=TOOL_INTERNAL_TOKEN="$TOOL_TOKEN" \
  --from-literal=TOOL_GATEWAY_TOKEN="$TOOL_TOKEN" \
  --from-literal=WORKSPACE_INTERNAL_TOKEN="$WORKSPACE_TOKEN" \
  --from-literal=OBJECT_STORAGE_ACCESS_KEY_ID='***' \
  --from-literal=OBJECT_STORAGE_SECRET_ACCESS_KEY='***'

# ③ ConfigMap / PVC / RBAC
kubectl apply -f k8s/10-configmap.yaml \
  -f k8s/11-configmap-model-gateway.yaml \
  -f k8s/12-configmap-capability-gateway.yaml \
  -f k8s/13-configmap-common-capability.yaml \
  -f k8s/14-configmap-workspace-service.yaml \
  -f k8s/15-pvc-agent-runtime-workspaces.yaml \
  -f k8s/16-rbac-workspace-service.yaml

# ④ 首次部署：先只应用 runtime（21 号），用它执行 §9 的数据库迁移
kubectl apply -f k8s/21-deployment-agent-runtime.yaml
kubectl -n billy rollout status deploy/billy-agent-runtime --timeout=300s
kubectl -n billy exec deploy/billy-agent-runtime -- \
  node node_modules/typeorm/cli.js migration:run -d node_modules/@repo/db/data-source.mjs

# ⑤ 迁移成功后再滚动其余五个工作负载（先起能力网关，common / workspace 才能尽快登记成功）
kubectl apply -f k8s/20-deployment.yaml \
  -f k8s/22-deployment-model-gateway.yaml \
  -f k8s/23-deployment-capability-gateway.yaml \
  -f k8s/24-deployment-common-capability.yaml \
  -f k8s/25-deployment-workspace-service.yaml
# ⑥ Service → PDB / HPA → Ingress
kubectl apply -f k8s/30-service.yaml -f k8s/31-service-agent-runtime.yaml \
  -f k8s/32-service-model-gateway.yaml -f k8s/33-service-capability-gateway.yaml \
  -f k8s/34-service-common-capability.yaml -f k8s/35-service-workspace-service.yaml
kubectl apply -f k8s/40-pdb.yaml -f k8s/60-hpa.yaml
kubectl apply -f k8s/50-ingress.yaml -f k8s/51-ingress-sse.yaml
```

必须替换 / 同步的占位符：

- **镜像地址与 tag**：`20`–`25` 六个 Deployment 的 `image`（`25` 当前写的是无 registry 前缀的 `billy-workspace-service:latest`，同样要换）；
- `15` 的 `storageClassName`（默认注释掉 = 集群默认类，通常不是 RWX，见 §6）；
- `50` / `51` 的 `host: api.example.com`（两份必须一致）；
- `10-configmap.yaml` 里 `billy-main` / `billy-agent-runtime` 的 `APP_VERSION` 分别与各自镜像 tag 一致（两者可以不同 tag）；

文件名前缀已按依赖排序，Secret 建好后也可以一次 `kubectl apply -f k8s/`（kubectl 按文件名顺序处理，会忽略 `README.md`）。

## 2. Secret `billy-app` 的键（缺必需键，对应 Pod 直接起不来）

| 键 | 消费者 | 说明 |
| --- | --- | --- |
| `DB_URL` | 六个服务 | PostgreSQL 连接串；common-capability 优先读 `TOOL_WORKER_DB_URL`、workspace-service 优先读 `WORKSPACE_DB_URL`，未设时回落到它 |
| `REDIS_URL` | main / runtime / model-gateway / capability-gateway / common-capability | Redis 连接串（pub/sub、会话租约、能力注册表、缓存）；workspace-service 不连 Redis |
| `JWT_SECRET` | main / runtime | 签发校验 JWT |
| `AGENT_INTERNAL_TOKEN` | main / runtime | main → runtime 内部接口（`/internal/agent/*`）的凭证，两边必须相同 |
| `MODEL_INTERNAL_TOKEN` | **model-gateway** | 网关自身校验的令牌（`x-internal-token`） |
| `MODEL_GATEWAY_TOKEN` | **agent-runtime / billy-main** | 调用模型网关时携带的令牌；**必须与 `MODEL_INTERNAL_TOKEN` 同值** |
| `TOOL_INTERNAL_TOKEN` | **capability-gateway / common-capability**（校验方），agent-runtime / billy-main（调用方），workspace-service（向网关登记时携带） | 能力登记 / 调用的内部令牌；这些位置必须完全一致 |
| `TOOL_GATEWAY_TOKEN` | agent-runtime / billy-main（可选） | 调用侧别名；按 `TOOL_GATEWAY_TOKEN` → `TOOL_INTERNAL_TOKEN` 回落，通常与 `TOOL_INTERNAL_TOKEN` 同值即可 |
| `WORKSPACE_INTERNAL_TOKEN` | **workspace-service**（校验方），billy-main / common-capability（调用方） | 工作区 ensure / stop / destroy、exec、fs 的凭证，两边必须相同 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY` | main / runtime / common-capability | 对象存储密钥（provider / region / bucket / endpoint 在 `billy-shared`） |
| `SHARE_INTERNAL_SECRET` | 可选 | 启用文件分享时加；main 的 `/share/resolve` 与 admin 侧同名变量一致（admin 不在本目录，属 compose / web 部署） |

可选键：`ALERT_SMTP_*`、`LARK_APP_ID` + `LARK_APP_SECRET`（通知 / 飞书客户端，不配只是不发通知）。

**不再需要的键**：`MASTRA_API_KEY` 不用放进 Secret。供应商 / 模型现在由后台「模型管理」入库、由
model-gateway 读取；`MASTRA_*` 只保留为 main **首次启动的可选种子**（`AGENT_SEED_FROM_ENV` 默认 true，
且库里一条供应商都没有时才会写入），不是运行时模型来源。也没有任何 Pod 需要 `MASTRA_*` 才能启动。

> 生产建议用 SealedSecret / External Secrets / SOPS，别落盘明文。
>
> 敏感值**只允许**出现在 Secret 里：`MODEL_INTERNAL_TOKEN` / `MODEL_GATEWAY_TOKEN` / `TOOL_INTERNAL_TOKEN` /
> `TOOL_GATEWAY_TOKEN` / `WORKSPACE_INTERNAL_TOKEN` / `DB_URL` / `REDIS_URL` 等一个都不要写进 ConfigMap
>（本目录的 ConfigMap 里全部没有）。

## 3. 六个服务的端口与依赖

| 服务 | 容器端口 | K8s Service | 对外 | 依赖 |
| --- | --- | --- | --- | --- |
| `billy-main` | 9989 | `billy-main:80` → `http(9989)` | Ingress `api.example.com` / `/sse` | PostgreSQL、Redis、MinIO、**billy-agent-runtime**、**billy-model-gateway**、**billy-capability-gateway**、**billy-workspace-service** |
| `billy-agent-runtime` | 9990 | `billy-agent-runtime:9990` → `http(9990)` | 无 | PostgreSQL、Redis、MinIO、**billy-model-gateway**、**billy-capability-gateway**、工作区 PVC（RWX） |
| `billy-model-gateway` | 9992 | `billy-model-gateway:9992` → `http(9992)` | 无 | PostgreSQL（模型配置 / 用量）、Redis（缓存）、上游模型供应商（出站） |
| `billy-capability-gateway` | 9993 | `billy-capability-gateway:9993` → `http(9993)` | 无 | PostgreSQL（审计 / 工具配置 / 服务授权）、Redis（能力注册表）、**billy-common-capability**、**billy-workspace-service**、MCP / 外部服务（出站） |
| `billy-common-capability` | 9994 | `billy-common-capability:9994` → `http(9994)` | 无 | PostgreSQL、Redis、MinIO、**billy-capability-gateway**（登记）、**billy-workspace-service**（`WorkspaceFsPort`） |
| `billy-workspace-service` | 9995 | `billy-workspace-service:9995` → `http(9995)` | 无 | PostgreSQL（只读 `ai_workspaces`）、Kubernetes API（创建 / exec / 删除工作区 Pod）、可拉取的工作区镜像 |

跨服务地址（改 Service 名 / 端口时必须同步）：

- main → runtime：`AGENT_RUNTIME_URL=http://billy-agent-runtime.billy.svc.cluster.local:9990`（`billy-main` ConfigMap）；
- runtime → 模型网关：`MODEL_GATEWAY_URL=http://billy-model-gateway.billy.svc.cluster.local:9992`（`billy-agent-runtime` ConfigMap）；
- main → 模型网关：`MODEL_GATEWAY_URL`（`billy-main` ConfigMap，后台「模型管理」的明细同步）；
- runtime / main → 能力网关：`TOOL_GATEWAY_URL=http://billy-capability-gateway.billy.svc.cluster.local:9993`
  （`billy-agent-runtime` / `billy-main` ConfigMap 都已显式配置；runtime 的工具面**默认就走能力网关**，
  进程内执行体已删除，模型面工具清单也来自网关的能力目录）；
- main → 工作区执行面：`WORKSPACE_SERVICE_URL=http://billy-workspace-service.billy.svc.cluster.local:9995`
  （`billy-main` ConfigMap，后台文件页 / 工作区控制）；
- common-capability：
  - `CAPABILITY_GATEWAY_URL=http://billy-capability-gateway.billy.svc.cluster.local:9993`（**启动登记地址**；
    不配会跳过登记，后台能力目录里就没有 `common` 的 9 个能力）；
  - `WORKSPACE_SERVICE_URL=http://billy-workspace-service.billy.svc.cluster.local:9995`（`WorkspaceFsPort`，
    供 `file-submit` / `file-download` 读写工作区；不配会回落 `127.0.0.1:9995`，Pod 里必然调不到）；
- workspace-service：
  - `WORKSPACE_GATEWAY_URL=http://billy-capability-gateway.billy.svc.cluster.local:9993`（**启动登记地址**；
    不配会跳过登记，`bash` / 文件能力就没有提供方）；
  - `WORKSPACE_SERVICE_ENDPOINT=http://billy-workspace-service.billy.svc.cluster.local:9995`（**登记时上报的
    本实例地址**，网关选路后回调它执行 `/invoke`；不配会回落 `127.0.0.1:9995`，网关在别的 Pod 上打不到）；
- 能力网关没有静态 worker 兜底地址：它从 Redis 注册表按 `active / maxConcurrency` 选实例，再直连该实例
  上报的地址（common-capability 用 Pod IP，workspace-service 用 `WORKSPACE_SERVICE_ENDPOINT`）。

前端只连 main，web / admin 的 `SERVER_URL` 指向 main 的公网地址；**不要给四个内部服务建 Ingress / NodePort**。

## 4. 跨文件取值不变量（改任意一个都要连带核对）

| 不变量 | 原因 |
| --- | --- |
| `SHUTDOWN_TIMEOUT_MS`(25s) + preStop(8s) **<** `terminationGracePeriodSeconds`(60s) | 否则排空没走完就被 SIGKILL，在途请求照样被切断。main / runtime 有 `SHUTDOWN_TIMEOUT_MS`；model-gateway / capability-gateway / common-capability 有 preStop(8s) 但无 `SHUTDOWN_TIMEOUT_MS`；workspace-service 两者都没有，只有 60s 期限 |
| 后端 `KEEP_ALIVE_TIMEOUT_MS`(75s) **>** 网关上游空闲超时（ingress-nginx 默认 60s） | 后端先关空闲连接 → 网关往死 socket 发请求 → 无痕 502（详见根目录 README「前置反向代理」） |
| `HEADERS_TIMEOUT_MS`(80s) **>** `KEEP_ALIVE_TIMEOUT_MS`(75s) | Node 对此不报错、静默接受，故 app 在配置层显式拦（反序会启动失败） |
| 探针 `timeoutSeconds`(2s) ≈ app 内探活超时(2s)（main / runtime / common-capability 有显式 2s 超时） | 依赖假死时 app 自己先返回 503，而不是让探针超时后盲判 |
| `readinessProbe` → `/readyz`，`livenessProbe` / `startupProbe` → `/healthz` | liveness 探外部依赖会在依赖抖动时重启**全部** Pod（重启修不好 DB，只会放大故障） |
| `replicas`/HPA `minReplicas`(3) > `minAvailable`(2) ≥ 1 | PDB 需留出可驱逐余量，否则节点排水会一直挂住 |
| `APP_VERSION`（main / runtime 各自的 ConfigMap）== **该服务**镜像 tag | 滚动更新后用 `GET /info` 核对线上实际构建；main 与 runtime 的 tag 可不同，各自核对 |
| `AGENT_INTERNAL_TOKEN` 在 main / runtime 完全相同 | 否则 `/internal/agent/*` 一律 401；用共享 Secret `billy-app` 保证 |
| `MODEL_INTERNAL_TOKEN`(网关读) == `MODEL_GATEWAY_TOKEN`(runtime / main 读) | 键名不同、值必须相同，否则调用模型网关一律 401 |
| `TOOL_INTERNAL_TOKEN` 在 capability-gateway / common-capability / workspace-service(登记) / runtime / main 完全相同 | 否则能力登记 / 调用 403；若另设 `TOOL_GATEWAY_TOKEN`，也必须与它同值 |
| `WORKSPACE_INTERNAL_TOKEN` 在 workspace-service / main / common-capability 完全相同 | 否则工作区 ensure / stop / destroy、exec、fs 一律 403 |
| `AGENT_RUNTIME_URL` == runtime Service 的 DNS + 端口 | 改 Service 名 / 端口时必须同步 `billy-main` ConfigMap |
| `MODEL_GATEWAY_URL` == model-gateway Service 的 DNS + 端口 | runtime 与 main 两份 ConfigMap 都要改 |
| `TOOL_GATEWAY_URL` == capability-gateway Service 的 DNS + 端口 | runtime 与 main 两份 ConfigMap 都要改 |
| `WORKSPACE_SERVICE_URL` == workspace-service Service 的 DNS + 端口 | main 与 common-capability 两份 ConfigMap 都要改 |
| `CAPABILITY_GATEWAY_URL` / `WORKSPACE_GATEWAY_URL` == capability-gateway Service 的 DNS + 端口 | 改 Service 名 / 端口时要同步 common-capability / workspace-service 的登记地址 |
| 每个服务的 `PORT` == 容器端口 == Service `targetPort`（名称统一 `http`） | 端口名是 Service 与探针的共同引用点；不一致时 Service 直接没有 endpoint |
| `TOOL_WORKER_ENDPOINT` 用 **Pod IP**（downward API `status.podIP`）而不是 Service DNS | 网关按注册表选中实例后直连该地址；走 Service 会被 kube-proxy 轮询到别的 Pod，实例选路 / 任务归属失效 |
| `WORKSPACE_SERVICE_ENDPOINT` == workspace-service 的 Service DNS + 端口（当前 1 副本） | 登记时上报的回调地址；写错时网关能登记、但一调 `/invoke` 就连不上 |
| PVC 挂载路径 `/home/appuser/.billy/workspaces` == `AGENT_COMMAND_WORK_DIR` | runtime 的附件物化 / 本地工作区根；不一致时持久化等于没做 |
| workspace-service 的 Deployment 必须 `serviceAccountName: billy-workspace-service`，且 16 号文件先于它 apply | 否则创建 / exec / 删除工作区 Pod 一律 403 |
| `WORKSPACE_CONTAINER_RUNTIME=kubernetes` 时容器里必须有可用的 kubectl + kubeconfig | 执行面用 kubectl 操作 Pod；镜像只装 kubectl，「凭据由运行环境提供」，清单本身没有注入 kubeconfig（见 §10） |
| HPA 生效后 Deployment 的 `replicas` 只是初值 | 改副本数要改 HPA 的 `minReplicas`，否则不生效 |

## 5. HPA 的前置条件（必须先有 metrics-server）

`60-hpa.yaml` 用的是 `autoscaling/v2` + Resource 指标（CPU 70%），只覆盖 **main / runtime / model-gateway**
三个面向请求的服务。**没有 metrics-server 时 HPA 不会报错、也不会扩容**，只会一直停在 `minReplicas`
并在事件里刷：

```
unable to get metrics for resource cpu: ... metrics not available
```

上线前先确认：

```bash
kubectl top pods -n billy          # 能输出 CPU/MEM 才说明 metrics 链路通
kubectl -n billy get hpa            # TARGETS 列不应长期是 <unknown>/70%
```

还要注意：

- **利用率按 requests 算**：main 100m → 70m 触发；runtime 250m → 175m；model-gateway 200m → 140m。调 requests 等于调扩容灵敏度；
- HPA 接管后，Deployment 里的 `replicas` 不再生效；要把下限 3 / 2 / 2 与 PDB、Node 容量一起核对；
- 扩出来的 Pod 受 `podAntiAffinity` 影响，节点不够会 Pending；集群需要留出可调度余量（或配 cluster-autoscaler）；
- 缩容默认有 5 分钟稳定窗（`stabilizationWindowSeconds=300`），流量突降不会立刻砍副本；
- **runtime 的 `maxReplicas: 8` 依赖工作区 PVC 是 RWX**；只有 RWO 时不要开 HPA（见 §6）；
- **capability-gateway / common-capability / workspace-service 不配 HPA**：网关只做目录 / 路由 / 审计；
  common-capability 固定 1 副本（进程内任务句柄 / 旧数据本地回落）；workspace-service 固定 1 副本
  （工作区 handle 映射在内存里，多副本会重复管理同一批 Pod）。

## 6. 工作区 PVC 与 workspace-service 的前置条件

### runtime 工作区 PVC（必须 RWX）

`15-pvc-agent-runtime-workspaces.yaml` 申请的是 **ReadWriteMany / 20Gi**，挂到 `/home/appuser/.billy/workspaces`，
对应 `billy-agent-runtime` ConfigMap 的 `AGENT_COMMAND_WORK_DIR`。这个卷现在承载的是 **runtime 侧的入站附件
物化 / 本地工作区根**（布局 `{根}/{conversationId}/`）；`bash` 与工作区文件能力已经迁到 workspace-service
的容器里执行，后者的 `/workspace` 是 emptyDir，**不挂这个 PVC**。

上线前必须确认存储侧真的支持 RWX：

```bash
kubectl get storageclass                    # 看有没有 RWX 能力的类（nfs-client / cephfs / efs-sc / azurefile …）
kubectl -n billy get pvc                    # STATUS 必须是 Bound，不是 Pending
```

- 清单里 `storageClassName` 默认**注释掉**：注释掉 = 用集群默认存储类，而默认类通常是 **RWO**（EBS / local-path / 云盘），
  多副本会挂不上或第二个 Pod 一直 Pending。**上线前按集群改成能提供 RWX 的类**；
- 只有 RWO 的集群：把 agent-runtime 改成单副本（StatefulSet 或 `replicas: 1` 的 Deployment），并删掉 / 把
  `60-hpa.yaml` 里 runtime 的 HPA 上限设为 1；否则多副本 + RWO 必然起不来；
- 写权限由存储类决定：容器以非 root 的 `appuser` 运行，`/readyz` 正常但写文件 EACCES 时，给 Pod 补
  `securityContext.fsGroup`（值取镜像内 `appuser` 的 UID：`docker run --rm <镜像> id appuser`），或在存储侧设好目录属主；
- PVC 扩容还要求存储类 `allowVolumeExpansion: true`。

### workspace-service（不挂业务 PVC）

- **不挂业务 PVC**：kubernetes 后端下，工作区就是一个带 `app=billy-workspace` 标签的 Pod
  （`sleep infinity`，`/workspace` 用 emptyDir），由 workspace-service 通过 kubectl 创建 / exec / 删除；
- **RBAC**：`16-rbac-workspace-service.yaml` 只授 `pods` 的 get/list/watch/create/delete 与 `pods/exec` 的
  create/get，不给其它资源；Deployment 通过 `serviceAccountName` 使用它。**漏配 SA / RBAC 时执行面 403**；
- **固定 1 副本**：运行态（`workspaceId → handle / 容器名` + 空闲回收）在执行面内存里，多副本会各自管理同一批
  Pod、重复回收；要横向扩，先把运行态做成分区 / 一致性租约，并让每个 Pod 上报自己的
  `WORKSPACE_SERVICE_ENDPOINT`；
- **kubectl 凭据**：镜像只装 kubectl（`docker/Dockerfile.workspace-service` 注释也写明「kubeconfig 由运行环境提供」），
  本目录**没有**注入 `KUBECONFIG` / in-cluster 凭据的清单；上线前必须由运行环境补上（kubectl 不自动读 Pod 内的
  ServiceAccount token，见 §10）；
- **工作区镜像**：`WORKSPACE_DEFAULT_IMAGE`（默认 `billy-workspace:2026.11.0`）必须能被集群节点拉取；
  工作区 Pod 不带 `imagePullSecrets`，私有仓库需要节点级凭据或把镜像放到可达 registry；
- 工作区 Pod 的 `/workspace` 是 emptyDir：**Pod 回收后未提交文件即丢失**；文件真相在对象存储
  （`file-submit` 提交过的文件）与数据库记录里。

## 7. Ingress 侧 / 集群侧还需核对

两份 Ingress 都指向 `billy-main`，`ingress-nginx` 按「最长路径优先」合并：

- `50-ingress.yaml`：常规入口（`/`），`proxy-body-size: 2m`（与 main 的 `useBodyParser` 上限一致）、读写超时 3600s；
- `51-ingress-sse.yaml`：SSE 路径 `/sse`、`/agent/chat/stream`、`/agent/run`，`proxy-buffering: off` +
  `proxy-http-version: 1.1` + 放大读写超时。不关缓冲会让流式输出「攒一批再吐」。

注意：main 还有 `/agent/chat/resume`（回答工具挂起问题时也是 SSE）。它**不在 51 的路径列表里**，走的是常规
Ingress；main 的 SSE 响应头带 `x-accel-buffering: no`，是否需要单独关缓冲请按 ingress-nginx 实测确认（见 §10）。

集群侧还需核对：

- **`upstream-keepalive-timeout`（默认 60s）必须小于后端 `KEEP_ALIVE_TIMEOUT_MS`（75s）**。默认值已经安全；
  若有人把它调到 75s 以上，必须同步调大 `KEEP_ALIVE_TIMEOUT_MS`，否则重现「网关复用已关闭连接 → 502」。
  查看与修改：

  ```bash
  kubectl -n ingress-nginx get configmap ingress-nginx-controller -o yaml | grep -i keepalive
  ```

- 若前面还有云 LB / WAF，同样按「从外到内空闲超时递增、每跳留 5s 以上余量」核对；
- **PDB 不约束滚动更新**（滚动更新由 `maxUnavailable` 约束），它挡的是节点排水 / 批量驱逐与滚动更新叠加
  把全部实例一起打死。

## 8. 上线后验证（不看「没报错」就算过）

```bash
# 六个 Deployment 都要就绪
for d in billy-main billy-agent-runtime billy-model-gateway \
         billy-capability-gateway billy-common-capability billy-workspace-service; do
  kubectl -n billy rollout status deploy/$d --timeout=300s
done

# main 探针语义（Pod 内直连，绕开 Ingress；镜像内置 curl）
kubectl -n billy exec deploy/billy-main -- sh -c \
  'curl -fsS http://127.0.0.1:9989/healthz; echo; \
   curl -fsS http://127.0.0.1:9989/readyz; echo; \
   curl -fsS http://127.0.0.1:9989/info; echo'

# runtime 探针 + 从 main Pod 验证 AGENT_RUNTIME_URL / DNS / 内部令牌
kubectl -n billy exec deploy/billy-agent-runtime -- sh -c \
  'curl -fsS http://127.0.0.1:9990/healthz; echo; \
   curl -fsS http://127.0.0.1:9990/readyz; echo; \
   curl -fsS http://127.0.0.1:9990/info; echo'
kubectl -n billy exec deploy/billy-main -- sh -c \
  'test -n "$AGENT_INTERNAL_TOKEN" && echo token-ok; \
   curl -sS -o /dev/null -w "runtime-healthz=%{http_code}\n" \
     http://billy-agent-runtime.billy.svc.cluster.local:9990/healthz'
# 内部令牌必须真的生效：不带 x-internal-token 调 runtime 内部接口应当 401（不是 404 / 200）
kubectl -n billy exec deploy/billy-main -- sh -c \
  'curl -sS -o /dev/null -w "no-token=%{http_code}\n" -X POST \
     -H "content-type: application/json" -d "{}" \
     http://billy-agent-runtime.billy.svc.cluster.local:9990/internal/agent/chat/stream'

# model-gateway：探针 + 从 runtime / main 侧验证 MODEL_GATEWAY_URL / 令牌
kubectl -n billy exec deploy/billy-model-gateway -- sh -c \
  'curl -fsS http://127.0.0.1:9992/healthz; echo; \
   curl -fsS http://127.0.0.1:9992/readyz; echo'
kubectl -n billy exec deploy/billy-agent-runtime -- sh -c \
  'test -n "$MODEL_GATEWAY_TOKEN" && echo token-present; \
   curl -sS -o /dev/null -w "gateway-healthz=%{http_code}\n" \
     http://billy-model-gateway.billy.svc.cluster.local:9992/healthz'

# capability-gateway：探针 + 目录 + 令牌
kubectl -n billy exec deploy/billy-capability-gateway -- sh -c \
  'curl -fsS http://127.0.0.1:9993/healthz; echo; \
   curl -fsS http://127.0.0.1:9993/readyz; echo'
# 能力目录应当能看到 common 的 9 个能力与 workspace 的 bash / 文件能力（内部服务不受服务授权过滤；
# 后台停用的工具可能缺席）
kubectl -n billy exec deploy/billy-capability-gateway -- sh -c \
  'curl -fsS -X POST -H "x-internal-token: $TOOL_INTERNAL_TOKEN" -H "content-type: application/json" \
     -d "{\"caller\":{\"userId\":\"probe\",\"isAdmin\":false,\"agentKey\":\"probe\",\"rootAgentKey\":\"probe\"},\"agentKey\":\"probe\"}" \
     http://127.0.0.1:9993/v1/capabilities/list' | head -c 2000; echo
# 带错令牌应当 403（不是 401 也不是 200）
kubectl -n billy exec deploy/billy-capability-gateway -- sh -c \
  'curl -sS -o /dev/null -w "wrong-token=%{http_code}\n" -X POST \
     -H "x-internal-token: nope" -H "content-type: application/json" -d "{}" \
     http://127.0.0.1:9993/v1/capabilities/list'

# common-capability / workspace-service：探针 + 从 main 验证 WORKSPACE_SERVICE_URL
kubectl -n billy exec deploy/billy-common-capability -- sh -c \
  'curl -fsS http://127.0.0.1:9994/healthz; echo; \
   curl -fsS http://127.0.0.1:9994/readyz; echo'
kubectl -n billy exec deploy/billy-workspace-service -- sh -c \
  'curl -fsS http://127.0.0.1:9995/healthz; echo; \
   curl -fsS http://127.0.0.1:9995/readyz; echo'
kubectl -n billy exec deploy/billy-main -- sh -c \
  'test -n "$WORKSPACE_INTERNAL_TOKEN" && echo ws-token-present; \
   curl -sS -o /dev/null -w "workspace-healthz=%{http_code}\n" \
     http://billy-workspace-service.billy.svc.cluster.local:9995/healthz'

# 登记是否真的发生：目录里应同时出现 service=common 与 service=workspace（同上 capabilities/list）
# 未配置 CAPABILITY_GATEWAY_URL / WORKSPACE_GATEWAY_URL 时，对应服务会打 "未配置能力网关地址，跳过能力登记" 的 warn。

# HPA / PVC 状态
kubectl -n billy get hpa
kubectl -n billy get pvc billy-agent-runtime-workspaces

# 滚动更新期间持续打请求，统计非 2xx（这是唯一能证明「不 502」的实验）
kubectl -n billy rollout restart deploy/billy-main
# 另开一个终端：
#   while true; do curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/config/get \
#     -X POST -H 'content-type: application/json' -d '{}'; sleep 0.2; done | sort | uniq -c

# 出现 502 时，先确认打到了哪个 upstream（Terminating 中的 Pod 是决定性证据）
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=200 | grep -E " 502 "
```

SSE 专项：挂着 `POST /sse/subscribe` 长连接做一次 `rollout restart deploy/billy-main`，客户端应当收到
`event: stream.shutdown` 后**自动重连**（而不是流静默失效）。SSE（`/sse/subscribe`、`/agent/chat/stream`、
`/agent/run*`、`/agent/chat/resume`）只经 main 的 Ingress；runtime 不直接对客户端提供 SSE。

> main 与 runtime 的 `OpsModule` 提供 `/healthz`、`/readyz`、`/info`；readiness 使用 `/readyz`。
> model-gateway / capability-gateway / common-capability / workspace-service **都没有 `/info`**；
> 它们的 `/healthz`、`/readyz` 语义见各 Deployment 的探针注释与 §10。

## 9. 数据库迁移：入口在 `@repo/db`

`db:migrate` / `db:generate` 的入口是 **`packages/db/data-source.ts`**，实体与迁移的事实源也都在
`@repo/db`。不要用 `@app/main` 或 `@app/agent-runtime` 的旧脚本跑迁移。

```bash
# 本地 / 构建机（脚本会先构建 @repo/db）
pnpm db:migrate
# 等价于：
pnpm --filter @repo/db run db:migrate
```

Compose 已内置一次性 `migrate` 服务（与 runtime 同镜像），在 `postgres` 健康后自动执行；
六个 Nest 服务的 compose 服务都 `depends_on: migrate`（completed_successfully）后再启动。

K8s 目前没有单独的迁移 Job；可在 runtime 镜像里直接执行（镜像内已带
`node_modules/@repo/db/data-source.mjs` 和 typeorm CLI）：

```bash
kubectl -n billy exec deploy/billy-agent-runtime -- \
  node node_modules/typeorm/cli.js migration:run -d node_modules/@repo/db/data-source.mjs
```

说明：

- 迁移是幂等的（TypeORM 通过 migrations 表判断）；
- 先跑迁移、再滚动更新六个 Deployment，避免新代码读旧表；
- 生产建议把上面的命令做成独立 Job，在 Deployment 滚动前执行。

## 10. 已知限制 / 上线前必须确认

- **metrics-server 未装 = HPA 不工作**（停在 minReplicas，不报错），见 §5；
- **存储类不支持 RWX = runtime 多副本起不来**，见 §6；只有 RWO 时改单副本并撤掉 runtime HPA；
- **workspace-service 固定 1 副本**（运行态在内存），不配 HPA；多副本前先做运行态外置 / 分区；
- **workspace-service 的 kubectl 凭据是缺口**：清单给 SA + RBAC，但镜像里的 kubectl 不会自动使用
  in-cluster ServiceAccount，需要运行环境注入 `KUBECONFIG` / 凭据（当前 Deployment 没有这部分）。上线前必须补齐，
  否则创建 / exec 工作区 Pod 会失败；
- **工作区 Pod 的 `/workspace` 是 emptyDir**：Pod 回收 / 重建后工作区里未提交的文件丢失；文件真相在对象存储
  （提交过的文件）与数据库里。runtime 的 PVC 只服务 runtime 侧的附件物化，不供工作区 Pod 使用；
- **工作区镜像必须集群可拉取**：`WORKSPACE_DEFAULT_IMAGE` 默认 `billy-workspace:2026.11.0` 且工作区 Pod 不带
  `imagePullSecrets`，私有 registry 需节点级凭据或可达的镜像地址；
- **common-capability 固定 1 副本**：进程内 task 句柄 / 在跑计数不共享，旧数据（会话未绑定 workspaceId）的文件
  回落本 Pod 本地盘；扩副本前先确认这两点。它的注册地址是 Pod IP（downward API），Pod 重建 / IP 变化靠
  心跳 + 重新登记收敛；
- **各服务 `/readyz` 的严格程度不同**：main / runtime / common-capability 探 DB + Redis；model-gateway 探 DB +
  模型目录；capability-gateway 探 Redis；**workspace-service 的 `/readyz` 恒为 200（不探 DB）**，DB 故障不会被
  readiness 摘流，只能从调用错误 / 日志发现；
- **Kafka 可选、当前无业务使用**：只有 `KAFKA_BROKERS` 存在时才装配 `KafkaModule`。AI 流式走 Redis pub/sub，
  不依赖 Kafka；不接异步消息时不要配它（也无需部署 Kafka）；
- **飞书 CLI 连接器已于 2026-11-18 删除**：连接器（lark-cli 驱动 / 后台页 / 状态同步）整模块下线；
  `docker/Dockerfile.agent-runtime` 仍预装 `lark-cli`（历史遗留，当前无代码消费），K8s 也不挂
  `~/.billy/lark-cli` 状态卷，不需要再做连接器授权；
- **main 的模型明细同步依赖 `MODEL_GATEWAY_URL`**（已在 `billy-main` ConfigMap 显式配置）；后台「模型管理」的
  供应商连通性测试 / 明细同步都经 model-gateway，main 自己不直连供应商；
- **51-ingress-sse.yaml 的路径覆盖**：只列了 `/sse`、`/agent/chat/stream`、`/agent/run`；`/agent/chat/resume`
  也是 SSE，目前走常规 Ingress，是否需要单独关缓冲需按 ingress-nginx 实测确认（见 §7）。
