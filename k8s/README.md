# Kubernetes 部署清单（main + agent-runtime）

覆盖两个服务：

- **billy-main**（`apps/main`，容器端口 **9989**）：公网唯一入口，HTTP / CRUD + Kafka SSE；有 Deployment / Service / Ingress / PDB；
- **billy-agent-runtime**（`apps/agent-runtime`，容器端口 **9990**）：内部服务，只由 main 通过 `AGENT_RUNTIME_URL` 调用；只有 Deployment / ClusterIP Service，**不接公网 Ingress**。

web / admin 的部署另议。清单里每个字段的「为什么这么取」都写在对应文件的注释里，这里给部署步骤、跨文件的取值不变量，以及上线后的验证方法。

## 1. 文件与部署顺序

| 文件 | 内容 |
| --- | --- |
| `00-namespace.yaml` | 命名空间（必须最先建） |
| `10-configmap.yaml` | 三份 ConfigMap：`billy-shared`（共用）/ `billy-main` / `billy-agent-runtime` |
| `20-deployment.yaml` | **main** Deployment（滚动策略 / preStop / 三类探针 / 优雅关闭期限） |
| `21-deployment-agent-runtime.yaml` | **agent-runtime** Deployment（同样的滚动与探针语义，端口 9990） |
| `30-service.yaml` | main 的 ClusterIP Service（80 → 容器 `http` 9989） |
| `31-service-agent-runtime.yaml` | agent-runtime 的 ClusterIP Service（9990 → 容器 `http` 9990） |
| `40-pdb.yaml` | main 的 PodDisruptionBudget（`minAvailable: 2`） |
| `50-ingress.yaml` | 常规入口（ingress-nginx）→ `billy-main` |
| `51-ingress-sse.yaml` | SSE 专用入口（`/sse`、`/agent/chat/stream`、`/agent/run`，关缓冲）→ `billy-main` |

配置拆分与共享：

- 非敏感配置按「共用 / main 专属 / runtime 专属」拆成三份 ConfigMap，Deployment 用 `envFrom` 依次引用；三份的键**不重复**，避免覆盖顺序歧义；
- 敏感配置统一放在 Secret **`billy-app`**，两个 Deployment 共用同一份。`AGENT_INTERNAL_TOKEN` 只维护一份，天然保证 main 与 runtime 一致——两边不一致时内部调用一律 401。

```bash
# ① 建命名空间
kubectl apply -f k8s/00-namespace.yaml

# ② 建共享 Secret（键名固定，缺一个 app 就起不来；不要提交真实值）
#    AGENT_INTERNAL_TOKEN 是 main → runtime 的内部调用凭证，两个服务必须相同，故只放在这一份 Secret 里。
kubectl -n billy create secret generic billy-app \
  --from-literal=DB_URL='postgresql://billy:***@postgres.billy.svc.cluster.local:5432/billy' \
  --from-literal=REDIS_URL='redis://:***@redis.billy.svc.cluster.local:6379/0' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=AGENT_INTERNAL_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=OBJECT_STORAGE_ACCESS_KEY_ID='***' \
  --from-literal=OBJECT_STORAGE_SECRET_ACCESS_KEY='***' \
  --from-literal=SHARE_INTERNAL_SECRET="$(openssl rand -hex 32)"
#    必需键：DB_URL / REDIS_URL / JWT_SECRET / AGENT_INTERNAL_TOKEN /
#            OBJECT_STORAGE_ACCESS_KEY_ID / OBJECT_STORAGE_SECRET_ACCESS_KEY
#    启用文件分享再加 SHARE_INTERNAL_SECRET（必须与 admin 侧同名变量一致，否则 /share/resolve 一律 404）
#    启用 AI 再加 MASTRA_API_KEY；可选 ALERT_SMTP_* / LARK_APP_ID / LARK_APP_SECRET
#    生产建议用 SealedSecret / External Secrets / SOPS，别落盘明文。

# ③ 改占位符后应用其余清单
#    必改：20/21 两个 Deployment 的镜像地址与 tag、50/51 的 host
#    同步：10-configmap.yaml 里 billy-main / billy-agent-runtime 的 APP_VERSION
#          分别与各自镜像 tag 一致（两个镜像可以不同 tag）
kubectl apply -f k8s/10-configmap.yaml \
  -f k8s/20-deployment.yaml -f k8s/21-deployment-agent-runtime.yaml \
  -f k8s/30-service.yaml -f k8s/31-service-agent-runtime.yaml \
  -f k8s/40-pdb.yaml \
  -f k8s/50-ingress.yaml -f k8s/51-ingress-sse.yaml
```

## 2. 两服务的端口与依赖

| 服务 | 容器端口 | K8s Service | 对外 | 依赖 |
| --- | --- | --- | --- | --- |
| `billy-main` | 9989 | `billy-main:80` → `http(9989)` | Ingress `api.example.com` / `/sse` | PostgreSQL、Redis、MinIO、**billy-agent-runtime**、Kafka（agent 对话时） |
| `billy-agent-runtime` | 9990 | `billy-agent-runtime:9990` → `http(9990)` | 无 | PostgreSQL、Redis、MinIO、Kafka（agent 对话时） |

main 通过 `AGENT_RUNTIME_URL=http://billy-agent-runtime.billy.svc.cluster.local:9990` 调 runtime 的 `/internal/agent/*`。runtime 只允许集群内访问；**不要给它建 Ingress / NodePort**。前端只连 main，web / admin 的 `SERVER_URL` 指向 main 的公网地址。

> **Kafka 不是「可有可无」的旁路**：agent 对话的流式内容由 runtime 发到 `agent.run.events`，main 消费后再写成前端 SSE（`AgentSseBridge`）。不配 `KAFKA_BROKERS` 时普通 CRUD 正常，但 `/agent/chat/stream` 收不到内容。生产启用 agent 必须在 `billy-shared` ConfigMap 里填上 Kafka 地址（集群内或外部均可）。

## 3. 跨文件取值不变量（改任意一个都要连带核对）

| 不变量 | 原因 |
| --- | --- |
| `SHUTDOWN_TIMEOUT_MS`(25s) + preStop(8s) **<** `terminationGracePeriodSeconds`(60s) | 否则排空没走完就被 SIGKILL，在途请求照样被切断（main / runtime 同） |
| 后端 `KEEP_ALIVE_TIMEOUT_MS`(75s) **>** 网关上游空闲超时（ingress-nginx 默认 60s） | 后端先关空闲连接 → 网关往死 socket 发请求 → 无痕 502（详见根目录 README「前置反向代理」） |
| `HEADERS_TIMEOUT_MS`(80s) **>** `KEEP_ALIVE_TIMEOUT_MS`(75s) | Node 对此不报错、静默接受，故 app 在配置层显式拦（反序会启动失败） |
| 探针 `timeoutSeconds`(2s) ≈ app 内探活超时(2s) | 依赖假死时 app 自己先返回 503，而不是让探针超时后盲判 |
| `readinessProbe` → `/readyz`，`livenessProbe` / `startupProbe` → `/healthz` | liveness 探外部依赖会在依赖抖动时重启**全部** Pod（重启修不好 DB，只会放大故障） |
| `replicas`(3) > `minAvailable`(2) ≥ 1 | PDB 需留出可驱逐余量，否则节点排水会一直挂住 |
| `APP_VERSION` == **对应服务**的镜像 tag | 滚动更新后用 `GET /info` 核对线上实际构建；main 与 runtime 的 tag 可不同，各自核对 |
| `AGENT_INTERNAL_TOKEN` 在 main / runtime 完全相同 | 否则 `/internal/agent/*` 一律 401；用共享 Secret `billy-app` 保证 |
| `AGENT_RUNTIME_URL` == runtime Service 的 DNS + 端口 | 改 Service 名 / 端口时必须同步 `billy-main` ConfigMap |
| runtime `PORT`(9990) == Service `targetPort` == `AGENT_RUNTIME_URL` 的端口 | `apps/agent-runtime` 的配置默认仍是 9989，漏配 `PORT` 会监听错端口 |

## 4. 集群侧还需核对（不在本目录，属 ingress-nginx 控制器配置）

- **`upstream-keepalive-timeout`（默认 60s）必须小于后端 `KEEP_ALIVE_TIMEOUT_MS`（75s）**。
  默认值已经安全；若有人把它调到 75s 以上，必须同步调大 `KEEP_ALIVE_TIMEOUT_MS`，否则重现
  「网关复用已关闭连接 → 502」。查看与修改：

  ```bash
  kubectl -n ingress-nginx get configmap ingress-nginx-controller -o yaml | grep -i keepalive
  ```

- 若前面还有云 LB / WAF，同样按「从外到内空闲超时递增、每跳留 5s 以上余量」核对。
- **PDB 不约束滚动更新**（滚动更新由 `maxUnavailable` 约束），它挡的是节点排水 / 批量驱逐与
  滚动更新叠加把全部实例一起打死。

## 5. 上线后验证（不看「没报错」就算过）

```bash
# 两个 Deployment 都要就绪
kubectl -n billy rollout status deploy/billy-main --timeout=300s
kubectl -n billy rollout status deploy/billy-agent-runtime --timeout=300s

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

## 6. 数据库迁移：入口在 `@repo/db`

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
- 先跑迁移、再滚动更新 `billy-main` / `billy-agent-runtime`，避免新代码读旧表；
- 生产建议把上面的命令做成独立 Job，在 Deployment 滚动前执行。

## 7. 飞书 CLI 连接器的状态落在 runtime Pod 本地

`agent-runtime` 镜像默认预装 `lark-cli`（`docker/Dockerfile.agent-runtime`），**main 镜像不装**；
连接器「飞书 CLI」的 App 配置与用户 token 在 `$HOME/.billy/lark-cli/<实例 id>`（容器里 `HOME=/home/appuser`）：

- **单副本 / 本地 compose**：`docker-compose.yaml` 已把 `lark-cli-data:/home/appuser/.billy` 只挂到 `agent-runtime`，重建容器不丢授权；
- **K8s 多副本（当前 `replicas: 2`）**：每个 Pod 各一份本地状态，没有共享卷时**每个 Pod 都要单独授权**，
  且 Pod 重建后授权丢失。要长期用，给 runtime 的 `/home/appuser/.billy` 挂 RWX PVC（或把 runtime 改成单副本 + `Recreate`），否则只适合"先跑通"的验证阶段；
- 删连接器只删本地目录，**不撤销飞书侧的授权**；需要撤销时在飞书后台处理。

## 8. 已知限制 / 上线前必须确认

- **main 多副本与 Kafka 消费者组**：`AgentSseBridge` 使用**每个 Pod 独立的消费组**（`main-sse-${POD_NAME|HOSTNAME|pid}`），每个 main 副本都会收到全量事件，只推本 Pod 的 `clientId`；不会出现“连接落在别的 Pod 收不到”的问题。跨 Pod 的 SSE 连接不需要粘性。
