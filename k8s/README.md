# Kubernetes 部署清单（main + agent-runtime + model-gateway / tool-gateway / tool-worker）

覆盖五个服务：

- **billy-main**（`apps/main`，容器端口 **9989**）：公网唯一入口，HTTP / CRUD + Kafka SSE；有 Deployment / Service / Ingress / PDB / HPA；
- **billy-agent-runtime**（`apps/agent-runtime`，容器端口 **9990**）：内部服务，只由 main 通过 `AGENT_RUNTIME_URL` 调用；Deployment / ClusterIP Service / 工作区 PVC / HPA，**不接公网 Ingress**；
- **billy-model-gateway**（`apps/model-gateway`，容器端口 **9992**）：内部模型网关，持有供应商 key、做 4 套协议适配；只给 runtime 调用；
- **billy-tool-gateway**（`apps/tool-gateway`，容器端口 **9993**）：内部工具面网关，鉴权 / 选 worker / 超时 / 审计；
- **billy-tool-worker**（`apps/tool-worker`，容器端口 **9994**）：内部工具执行体，真正跑命令。

后四个都只在内网，**不要给它们建 Ingress / NodePort**。web / admin 的部署另议。清单里每个字段的「为什么这么取」都写在对应文件的注释里，这里给部署步骤、跨文件的取值不变量，以及上线后的验证方法。

调用链（集群内 DNS 都是 `<service>.billy.svc.cluster.local`）：

```
前端 → Ingress → billy-main:80 → rw: billy-agent-runtime:9990
                                   ├─ MODEL_GATEWAY_URL → billy-model-gateway:9992
                                   └─ TOOL_GATEWAY_URL（可选）→ billy-tool-gateway:9993 → 静态兜底 billy-tool-worker:9994
                                                                                          └─ 正常路径：Redis 注册表里的 worker Pod IP
```

## 1. 文件与部署顺序

| 文件 | 内容 |
| --- | --- |
| `00-namespace.yaml` | 命名空间（必须最先建） |
| `10-configmap.yaml` | 三份 ConfigMap：`billy-shared`（共用）/ `billy-main` / `billy-agent-runtime` |
| `11-configmap-model-gateway.yaml` | model-gateway 专属 ConfigMap（`PORT=9992`、超时、连接池） |
| `12-configmap-tool-gateway.yaml` | tool-gateway 专属 ConfigMap（`PORT=9993`、worker 兜底地址、限流） |
| `13-configmap-tool-worker.yaml` | tool-worker 专属 ConfigMap（`PORT=9994`、工作区根、心跳、沙箱策略） |
| `15-pvc-agent-runtime-workspaces.yaml` | runtime 工作区 PVC（**RWX**，20Gi，storageClassName 需替换） |
| `20-deployment.yaml` | **main** Deployment（滚动策略 / preStop / 三类探针 / 优雅关闭期限） |
| `21-deployment-agent-runtime.yaml` | **agent-runtime** Deployment（同样的滚动与探针语义，端口 9990，挂工作区 PVC） |
| `22-deployment-model-gateway.yaml` | model-gateway Deployment（9992） |
| `23-deployment-tool-gateway.yaml` | tool-gateway Deployment（9993） |
| `24-deployment-tool-worker.yaml` | tool-worker Deployment（9994，默认单副本，原因见文件头注释） |
| `30-service.yaml` | main 的 ClusterIP Service（80 → 容器 `http` 9989） |
| `31-service-agent-runtime.yaml` | agent-runtime 的 ClusterIP Service（9990 → 容器 `http` 9990） |
| `32-service-model-gateway.yaml` | model-gateway 的 ClusterIP Service（9992） |
| `33-service-tool-gateway.yaml` | tool-gateway 的 ClusterIP Service（9993） |
| `34-service-tool-worker.yaml` | tool-worker 的 ClusterIP Service（9994） |
| `40-pdb.yaml` | main 的 PodDisruptionBudget（`minAvailable: 2`） |
| `50-ingress.yaml` | 常规入口（ingress-nginx）→ `billy-main` |
| `51-ingress-sse.yaml` | SSE 专用入口（`/sse`、`/agent/chat/stream`、`/agent/run`，关缓冲）→ `billy-main` |
| `60-hpa.yaml` | 三份 HPA：`billy-main` 3–8、`billy-agent-runtime` 2–8、`billy-model-gateway` 2–8，CPU 70% |

配置拆分与共享：

- 非敏感配置按「共用 / 各服务专属」拆成 ConfigMap，Deployment 用 `envFrom` 依次引用；同一 Pod 的各份键**不重复**，避免覆盖顺序歧义；
- `billy-shared` 放五个服务都可能用到的公共项（`NODE_ENV` / 对象存储 provider·region·bucket·endpoint / `LOG_LEVEL` / Kafka）；
- 敏感配置统一放在 Secret **`billy-app`**，所有 Deployment 共用同一份。共用同一份的意义是让「两边必须相同」的令牌天然一致（见 §3）。

```bash
# ① 建命名空间
kubectl apply -f k8s/00-namespace.yaml

# ② 建共享 Secret（键名固定；不要提交真实值）
#    两个随机令牌先落到变量里，再分别写进「必须同值」的两个键：
MODEL_TOKEN="$(openssl rand -hex 32)"
TOOL_TOKEN="$(openssl rand -hex 32)"

kubectl -n billy create secret generic billy-app \
  --from-literal=DB_URL='postgresql://billy:***@postgres.billy.svc.cluster.local:5432/billy' \
  --from-literal=REDIS_URL='redis://:***@redis.billy.svc.cluster.local:6379/0' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=AGENT_INTERNAL_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=MODEL_INTERNAL_TOKEN="$MODEL_TOKEN" \
  --from-literal=MODEL_GATEWAY_TOKEN="$MODEL_TOKEN" \
  --from-literal=TOOL_INTERNAL_TOKEN="$TOOL_TOKEN" \
  --from-literal=OBJECT_STORAGE_ACCESS_KEY_ID='***' \
  --from-literal=OBJECT_STORAGE_SECRET_ACCESS_KEY='***' \
  --from-literal=SHARE_INTERNAL_SECRET="$(openssl rand -hex 32)"

# ③ 换掉占位符后应用其余清单
#    必改：20–24 五个 Deployment 的镜像地址与 tag、15 的 storageClassName、50/51 的 host
#    同步：10-configmap.yaml 里 billy-main / billy-agent-runtime 的 APP_VERSION
#          分别与各自镜像 tag 一致；13-configmap-tool-worker.yaml 的 TOOL_WORKER_VERSION
#          与 worker 镜像 tag 一致（三个服务可以不同 tag）
kubectl apply -f k8s/10-configmap.yaml \
  -f k8s/11-configmap-model-gateway.yaml \
  -f k8s/12-configmap-tool-gateway.yaml \
  -f k8s/13-configmap-tool-worker.yaml \
  -f k8s/15-pvc-agent-runtime-workspaces.yaml
# ④ 首次部署：先只应用 runtime（21 号），用它执行 §8 的数据库迁移
kubectl apply -f k8s/21-deployment-agent-runtime.yaml
kubectl -n billy rollout status deploy/billy-agent-runtime --timeout=300s
kubectl -n billy exec deploy/billy-agent-runtime -- \
  node node_modules/typeorm/cli.js migration:run -d node_modules/@repo/db/data-source.mjs

# ⑤ 迁移成功后再滚动其余四个工作负载（三个新服务启动即连库，别抢在迁移之前）
kubectl apply -f k8s/20-deployment.yaml \
  -f k8s/22-deployment-model-gateway.yaml -f k8s/23-deployment-tool-gateway.yaml \
  -f k8s/24-deployment-tool-worker.yaml
# ⑥ Service → PDB / HPA → Ingress
kubectl apply -f k8s/30-service.yaml -f k8s/31-service-agent-runtime.yaml \
  -f k8s/32-service-model-gateway.yaml -f k8s/33-service-tool-gateway.yaml \
  -f k8s/34-service-tool-worker.yaml
kubectl apply -f k8s/40-pdb.yaml -f k8s/60-hpa.yaml
kubectl apply -f k8s/50-ingress.yaml -f k8s/51-ingress-sse.yaml
```

文件名前缀已按依赖排序，Secret 建好后也可以一次 `kubectl apply -f k8s/`（kubectl 按文件名顺序处理，会忽略 README.md）。

### Secret `billy-app` 的键（缺必需键，对应 Pod 直接起不来）

| 键 | 消费者 | 说明 |
| --- | --- | --- |
| `DB_URL` | main / runtime / model-gateway / tool-gateway / tool-worker | PostgreSQL 连接串；worker 优先读 `TOOL_WORKER_DB_URL`，未设时回落到它 |
| `REDIS_URL` | 全部五个 | Redis 连接串（worker 注册表 / 会话租约 / 缓存） |
| `JWT_SECRET` | main / runtime | 签发校验 JWT |
| `AGENT_INTERNAL_TOKEN` | main / runtime | main → runtime 内部调用凭证，两边必须相同 |
| `MODEL_INTERNAL_TOKEN` | **model-gateway** | 网关自身校验的令牌（`x-internal-token`） |
| `MODEL_GATEWAY_TOKEN` | **agent-runtime** | runtime 调网关时携带的令牌；**必须与 `MODEL_INTERNAL_TOKEN` 同值** |
| `TOOL_INTERNAL_TOKEN` | **tool-gateway / tool-worker**（runtime 亦读取） | gateway ↔ worker 的调用令牌；三处必须相同。runtime 的远程工具客户端按 `TOOL_GATEWAY_TOKEN` → `TOOL_INTERNAL_TOKEN` 依次回落，故通常只需这一个键 |
| `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY` | main / runtime / tool-worker | 对象存储密钥（其余对象存储配置在 `billy-shared`） |
| `SHARE_INTERNAL_SECRET` | 可选 | 启用文件分享时加，必须与 admin 侧同名变量一致 |

可选键：`MASTRA_API_KEY`（启用 AI）、`ALERT_SMTP_*` / `LARK_APP_ID` / `LARK_APP_SECRET`（通知）、`TOOL_GATEWAY_TOKEN`（与 `TOOL_INTERNAL_TOKEN` 同值即可，不设也能跑）。

> 生产建议用 SealedSecret / External Secrets / SOPS，别落盘明文。
>
> 敏感值**只允许**出现在 Secret 里：`MODEL_INTERNAL_TOKEN` / `MODEL_GATEWAY_TOKEN` / `TOOL_INTERNAL_TOKEN` / `TOOL_GATEWAY_TOKEN` / `DB_URL` / `REDIS_URL` 等一个都不要写进 ConfigMap（本目录的 ConfigMap 里全部没有）。

## 2. 五个服务的端口与依赖

| 服务 | 容器端口 | K8s Service | 对外 | 依赖 |
| --- | --- | --- | --- | --- |
| `billy-main` | 9989 | `billy-main:80` → `http(9989)` | Ingress `api.example.com` / `/sse` | PostgreSQL、Redis、MinIO、**billy-agent-runtime**、Kafka（agent 对话时） |
| `billy-agent-runtime` | 9990 | `billy-agent-runtime:9990` → `http(9990)` | 无 | PostgreSQL、Redis、MinIO、**billy-model-gateway**、工作区 PVC（RWX）、Kafka（agent 对话时）；可选 billy-tool-gateway |
| `billy-model-gateway` | 9992 | `billy-model-gateway:9992` → `http(9992)` | 无 | PostgreSQL（模型配置 / 用量）、Redis（缓存） |
| `billy-tool-gateway` | 9993 | `billy-tool-gateway:9993` → `http(9993)` | 无 | PostgreSQL（审计 / 工具配置）、Redis（worker 注册表）、**billy-tool-worker** |
| `billy-tool-worker` | 9994 | `billy-tool-worker:9994` → `http(9994)` | 无 | PostgreSQL、Redis、对象存储（S3/MinIO）；工作区在本 Pod 本地盘 |

- main 通过 `AGENT_RUNTIME_URL=http://billy-agent-runtime.billy.svc.cluster.local:9990` 调 runtime 的 `/internal/agent/*`；
- runtime 通过 `MODEL_GATEWAY_URL=http://billy-model-gateway.billy.svc.cluster.local:9992` 调模型网关；
- runtime 的远程工具面是**可选开关**：`billy-agent-runtime` ConfigMap 里没有 `TOOL_GATEWAY_URL`，默认走进程内工具；要切到工具网关，在 runtime ConfigMap 里加 `TOOL_GATEWAY_URL=http://billy-tool-gateway.billy.svc.cluster.local:9993`（令牌已由共享 Secret 提供）后滚动 runtime；
- 前端只连 main，web / admin 的 `SERVER_URL` 指向 main 的公网地址；**不要给四个内部服务建 Ingress / NodePort**。

> **Kafka 不是「可有可无」的旁路**：agent 对话的流式内容由 runtime 发到 `agent.run.events`，main 消费后再写成前端 SSE（`AgentSseBridge`）。不配 `KAFKA_BROKERS` 时普通 CRUD 正常，但 `/agent/chat/stream` 收不到内容。生产启用 agent 必须在 `billy-shared` ConfigMap 里填上 Kafka 地址（集群内或外部均可）。

## 3. 跨文件取值不变量（改任意一个都要连带核对）

| 不变量 | 原因 |
| --- | --- |
| `SHUTDOWN_TIMEOUT_MS`(25s) + preStop(8s) **<** `terminationGracePeriodSeconds`(60s) | 否则排空没走完就被 SIGKILL，在途请求照样被切断（main / runtime 同；三个新服务没有 `SHUTDOWN_TIMEOUT_MS`，靠 preStop + 60s 兜底） |
| 后端 `KEEP_ALIVE_TIMEOUT_MS`(75s) **>** 网关上游空闲超时（ingress-nginx 默认 60s） | 后端先关空闲连接 → 网关往死 socket 发请求 → 无痕 502（详见根目录 README「前置反向代理」） |
| `HEADERS_TIMEOUT_MS`(80s) **>** `KEEP_ALIVE_TIMEOUT_MS`(75s) | Node 对此不报错、静默接受，故 app 在配置层显式拦（反序会启动失败） |
| 探针 `timeoutSeconds`(2s) ≈ app 内探活超时(2s) | 依赖假死时 app 自己先返回 503，而不是让探针超时后盲判 |
| `readinessProbe` → `/readyz`，`livenessProbe` / `startupProbe` → `/healthz` | liveness 探外部依赖会在依赖抖动时重启**全部** Pod（重启修不好 DB，只会放大故障） |
| `replicas`/HPA `minReplicas`(3) > `minAvailable`(2) ≥ 1 | PDB 需留出可驱逐余量，否则节点排水会一直挂住 |
| `APP_VERSION` == **对应服务**的镜像 tag | 滚动更新后用 `GET /info` 核对线上实际构建；main 与 runtime 的 tag 可不同，各自核对 |
| `TOOL_WORKER_VERSION` == tool-worker 镜像 tag | worker 注册表按版本选路；不同步会让灰度 / 排障看到错的版本 |
| `AGENT_INTERNAL_TOKEN` 在 main / runtime 完全相同 | 否则 `/internal/agent/*` 一律 401；用共享 Secret `billy-app` 保证 |
| `MODEL_INTERNAL_TOKEN`(网关读) == `MODEL_GATEWAY_TOKEN`(runtime 读) | 键名不同、值必须相同，否则 runtime → model-gateway 一律 401 |
| `TOOL_INTERNAL_TOKEN` 在 gateway / worker / runtime 完全相同 | 否则 gateway ↔ worker 的调用 403；若另设 `TOOL_GATEWAY_TOKEN`，也必须与它同值 |
| `AGENT_RUNTIME_URL` == runtime Service 的 DNS + 端口 | 改 Service 名 / 端口时必须同步 `billy-main` ConfigMap |
| `MODEL_GATEWAY_URL` == model-gateway Service 的 DNS + 端口 | 改 Service 名 / 端口时必须同步 `billy-agent-runtime` ConfigMap |
| `TOOL_WORKER_URL` == tool-worker Service 的 DNS + 端口 | 只在注册表为空时兜底；改 Service 名 / 端口时要同步 `billy-tool-gateway` ConfigMap |
| 每个服务的 `PORT` == 容器端口 == Service `targetPort`（名称统一 `http`） | 端口名是 Service 与探针的共同引用点；不一致时 Service 直接没有 endpoint |
| `TOOL_WORKER_ENDPOINT` 用 **Pod IP** 而不是 Service DNS | gateway 按 `workerId` 做翻页 ref 亲和；走 Service 会被 kube-proxy 轮询到别的 Pod，亲和失效 |
| PVC 挂载路径 `/home/appuser/.billy/workspaces` == `AGENT_COMMAND_WORK_DIR` | runtime bash / 文件工具共用这个根；不一致时持久化等于没做 |
| HPA 生效后 Deployment 的 `replicas` 只是初值 | 改副本数要改 HPA 的 `minReplicas`，否则不生效 |

## 4. HPA 的前置条件（必须先有 metrics-server）

`60-hpa.yaml` 用的是 `autoscaling/v2` + Resource 指标（CPU 70%）。**没有 metrics-server 时 HPA 不会报错、也不会扩容**，只会一直停在 `minReplicas` 并在事件里刷：

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
- **runtime 的 `maxReplicas: 8` 依赖工作区 PVC 是 RWX**；只有 RWO 时不要开 HPA（见 §5）。

## 5. runtime 工作区 PVC 的前置条件（RWX）

`15-pvc-agent-runtime-workspaces.yaml` 申请的是 **ReadWriteMany / 20Gi**，挂到 `/home/appuser/.billy/workspaces`。上线前必须确认存储侧真的支持 RWX：

```bash
kubectl get storageclass                    # 看有没有 RWX 能力的类（nfs-client / cephfs / efs-sc / azurefile …）
kubectl -n billy get pvc                    # STATUS 必须是 Bound，不是 Pending
```

- 清单里 `storageClassName` 默认**注释掉**：注释掉 = 用集群默认存储类，而默认类通常是 **RWO**（EBS / local-path / 云盘），多副本会挂不上或第二个 Pod 一直 Pending。**上线前按集群改成能提供 RWX 的类**；
- 只有 RWO 的集群：把 agent-runtime 改成 **StatefulSet 单副本**（或 `replicas: 1` 的 Deployment），并删掉 / 上限设为 1 的 runtime HPA；否则多副本 + RWO 必然起不来；
- 写权限由存储类决定：容器以非 root 的 `appuser` 运行，`/readyz` 正常但写文件 EACCES 时，给 Pod 补 `securityContext.fsGroup`（值取镜像内 `appuser` 的 UID：`docker run --rm <镜像> id appuser`），或在存储侧设好目录属主；
- PVC 扩容还要求存储类 `allowVolumeExpansion: true`；
- 这个 PVC **只覆盖 workspaces**，不覆盖 `/home/appuser/.billy/lark-cli`（见 §9）；
- main 若需要读同一份工作区文件（`apps/main` 的 admin 文件模块默认也指向 `~/.billy/workspaces`），要另挂同一个 PVC 并设 `AGENT_COMMAND_WORK_DIR`；本目录没有改 main 的挂载。

## 6. 集群侧还需核对（不在本目录，属 ingress-nginx 控制器配置）

- **`upstream-keepalive-timeout`（默认 60s）必须小于后端 `KEEP_ALIVE_TIMEOUT_MS`（75s）**。
  默认值已经安全；若有人把它调到 75s 以上，必须同步调大 `KEEP_ALIVE_TIMEOUT_MS`，否则重现
  「网关复用已关闭连接 → 502」。查看与修改：

  ```bash
  kubectl -n ingress-nginx get configmap ingress-nginx-controller -o yaml | grep -i keepalive
  ```

- 若前面还有云 LB / WAF，同样按「从外到内空闲超时递增、每跳留 5s 以上余量」核对。
- **PDB 不约束滚动更新**（滚动更新由 `maxUnavailable` 约束），它挡的是节点排水 / 批量驱逐与
  滚动更新叠加把全部实例一起打死。

## 7. 上线后验证（不看「没报错」就算过）

```bash
# 五个 Deployment 都要就绪
for d in billy-main billy-agent-runtime billy-model-gateway billy-tool-gateway billy-tool-worker; do
  kubectl -n billy rollout status deploy/$d --timeout=300s
done

# main 探针语义（Pod 内直连，绕开 Ingress；镜像内置 curl）
kubectl -n billy exec deploy/billy-main -- sh -c \
  'curl -fsS -X POST http://127.0.0.1:9989/monitor/health; echo; \
   curl -fsS http://127.0.0.1:9989/readyz; echo; \
   curl -fsS http://127.0.0.1:9989/info; echo'

# runtime 探针 + 内部可达性（从 main Pod 里打 runtime Service，验证 AGENT_RUNTIME_URL / DNS 正确）
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

# model-gateway：探针 + 从 runtime 侧验证 MODEL_GATEWAY_URL / DNS / 令牌
kubectl -n billy exec deploy/billy-model-gateway -- sh -c \
  'curl -fsS http://127.0.0.1:9992/healthz; echo; \
   curl -fsS http://127.0.0.1:9992/readyz; echo'
kubectl -n billy exec deploy/billy-agent-runtime -- sh -c \
  'test -n "$MODEL_GATEWAY_TOKEN" && echo token-present; \
   curl -sS -o /dev/null -w "gateway-healthz=%{http_code}\n" \
     http://billy-model-gateway.billy.svc.cluster.local:9992/healthz'

# tool-gateway / tool-worker：探针 + 注册表 + 令牌
kubectl -n billy exec deploy/billy-tool-gateway -- sh -c \
  'curl -fsS http://127.0.0.1:9993/healthz; echo; \
   curl -fsS http://127.0.0.1:9993/readyz; echo'
kubectl -n billy exec deploy/billy-tool-worker -- sh -c \
  'curl -fsS http://127.0.0.1:9994/healthz; echo; \
   curl -fsS http://127.0.0.1:9994/readyz; echo'
# 注册表里至少应看到 1 个 worker（draining=false）；带错令牌应当 403（不是 401 也不是 200）
kubectl -n billy exec deploy/billy-tool-gateway -- sh -c \
  'curl -fsS -H "x-internal-token: $TOOL_INTERNAL_TOKEN" http://127.0.0.1:9993/v1/workers; echo; \
   curl -sS -o /dev/null -w "wrong-token=%{http_code}\n" -H "x-internal-token: nope" \
     http://127.0.0.1:9993/v1/workers'

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
`event: stream.shutdown` 后**自动重连**（而不是流静默失效）。SSE（`/sse/subscribe`、`/agent/chat/stream`、`/agent/run*`）只经 main 的 Ingress；runtime 不直接对客户端提供 SSE。

> runtime 的 `OpsModule` 提供 `/healthz`、`/readyz`、`/info`；readiness 使用 `/readyz`。
> model-gateway / tool-gateway / tool-worker 都没有 `/info`；它们的 `/healthz`、`/readyz` 语义见各 Deployment 的探针注释与 §10。

## 8. 数据库迁移：入口在 `@repo/db`

`db:migrate` / `db:generate` 的入口是 **`packages/db/data-source.ts`**，实体与迁移的事实源也都在
`@repo/db`。不要用 `@app/main` 或 `@app/agent-runtime` 的旧脚本跑迁移。

```bash
# 本地 / 构建机（脚本会先构建 @repo/db）
pnpm db:migrate
# 等价于：
pnpm --filter @repo/db run db:migrate
```

Compose 已内置一次性 `migrate` 服务（与 runtime 同镜像），在 `postgres` 健康后自动执行；
main / agent-runtime / gateway / worker 都依赖它成功完成再启动。

K8s 目前没有单独的迁移 Job；可在 runtime 镜像里直接执行（镜像内已带
`node_modules/@repo/db/data-source.mjs` 和 typeorm CLI）：

```bash
kubectl -n billy exec deploy/billy-agent-runtime -- \
  node node_modules/typeorm/cli.js migration:run -d node_modules/@repo/db/data-source.mjs
```

说明：

- 迁移是幂等的（TypeORM 通过 migrations 表判断）；
- 先跑迁移、再滚动更新 `billy-main` / `billy-agent-runtime` / 三个新服务，避免新代码读旧表；
- 生产建议把上面的命令做成独立 Job，在 Deployment 滚动前执行。

## 9. 飞书 CLI 连接器的状态落在 runtime Pod 本地

`agent-runtime` 镜像默认预装 `lark-cli`（`docker/Dockerfile.agent-runtime`），**main 镜像不装**；
连接器「飞书 CLI」的 App 配置与用户 token 在 `$HOME/.billy/lark-cli/<实例 id>`（容器里 `HOME=/home/appuser`）：

- **单副本 / 本地 compose**：`docker-compose.yaml` 已把 `lark-cli-data:/home/appuser/.billy` 只挂到 `agent-runtime`，重建容器不丢授权；
- **K8s 多副本（当前 `replicas: 2`，HPA 2–8）**：`15-pvc-agent-runtime-workspaces.yaml` **只挂了 `workspaces` 子目录**，
  `lark-cli` 仍各 Pod 一份本地状态 —— 每个 Pod 都要单独授权，且 Pod 重建后授权丢失。
  要长期用，给 `$HOME/.billy/lark-cli` 单独挂 RWX PVC（注意并发写语义要先验证），或把连接器固定到单副本；
- 删连接器只删本地目录，**不撤销飞书侧的授权**；需要撤销时在飞书后台处理。

## 10. 已知限制 / 上线前必须确认

- **metrics-server 未装 = HPA 不工作**（停在 minReplicas，不报错），见 §4；
- **存储类不支持 RWX = runtime 多副本起不来**，见 §5；只有 RWO 时改 StatefulSet / 单副本并撤掉 runtime HPA；
- **两个网关的 `/readyz` 已在依赖故障时返回 503**（model-gateway：DB 失败；tool-gateway：Redis 失败），readiness 会真正摘流；tool-worker 的 `/readyz` 原本就是 503；
- **tool-worker 默认单副本**：bash 工作区在每个 Pod 的本地盘，gateway 按负载选 worker，多副本会让同一会话的连续命令落到不同 Pod、看不到彼此文件。扩副本前先给工作区挂共享 RWX 卷（或做会话亲和）；
- **tool-worker 的 `AGENT_WORKSPACE_MODE=off`**：官方镜像的 runner 是纯 `node:alpine`，没有 bubblewrap，保持默认 `enforce` 时 `/readyz` 永远 503。`off` 下命令以 `appuser` 身份直接执行、**没有文件 / 网络隔离**，只适合自托管单租户；多租户上线前必须在镜像里装 bwrap、放开 unprivileged userns，再改回 `enforce`；
- **runtime 默认不走工具网关**：`billy-agent-runtime` ConfigMap 没有 `TOOL_GATEWAY_URL`，工具仍走进程内路径；要切远程工具面按 §2 加变量后滚动；
- **main 多副本与 Kafka 消费者组**：`AgentSseBridge` 使用**每个 Pod 独立的消费组**（`main-sse-${POD_NAME|HOSTNAME|pid}`），每个 main 副本都会收到全量事件，只推本 Pod 的 `clientId`；不会出现「连接落在别的 Pod 收不到」的问题。跨 Pod 的 SSE 连接不需要粘性。
