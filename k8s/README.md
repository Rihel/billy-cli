# Kubernetes 部署清单（server）

只覆盖 **apps/server**（NestJS）。web / admin 的部署另议。
清单里每个字段的「为什么这么取」都写在对应文件的注释里，这里给部署步骤、跨文件的取值不变量，
以及上线后的验证方法。

## 1. 文件与部署顺序

| 文件 | 内容 |
| --- | --- |
| `00-namespace.yaml` | 命名空间（必须最先建） |
| `10-configmap.yaml` | 非敏感运行配置（含 `KEEP_ALIVE_TIMEOUT_MS` / `SHUTDOWN_TIMEOUT_MS` / `APP_VERSION`） |
| `20-deployment.yaml` | Deployment（滚动策略 / preStop / 三类探针 / 优雅关闭期限） |
| `30-service.yaml` | ClusterIP Service（80 → 容器 `http` 9989） |
| `40-pdb.yaml` | PodDisruptionBudget（`minAvailable: 2`） |
| `50-ingress.yaml` | 常规入口（ingress-nginx） |
| `51-ingress-sse.yaml` | SSE 专用入口（`/sse`，关缓冲） |

```bash
# ① 建命名空间
kubectl apply -f k8s/00-namespace.yaml

# ② 建 Secret（键名固定，缺一个 app 就起不来；不要提交真实值）
kubectl -n billy create secret generic billy-server \
  --from-literal=DB_URL='postgresql://billy:***@postgres.billy.svc.cluster.local:5432/billy' \
  --from-literal=REDIS_URL='redis://:***@redis.billy.svc.cluster.local:6379/0' \
  --from-literal=JWT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=OBJECT_STORAGE_ACCESS_KEY_ID='***' \
  --from-literal=OBJECT_STORAGE_SECRET_ACCESS_KEY='***'
#    需要的键：DB_URL / REDIS_URL / JWT_SECRET / OBJECT_STORAGE_ACCESS_KEY_ID /
#    OBJECT_STORAGE_SECRET_ACCESS_KEY（可选：ALERT_SMTP_* / LARK_APP_ID / LARK_APP_SECRET）
#    生产建议用 SealedSecret / External Secrets / SOPS，别落盘明文。

# ③ 改占位符后应用其余清单
#    必改：20-deployment.yaml 的镜像地址与 tag、50/51 的 host
#    同步：10-configmap.yaml 的 APP_VERSION 与镜像 tag 一致
kubectl apply -f k8s/10-configmap.yaml -f k8s/20-deployment.yaml \
  -f k8s/30-service.yaml -f k8s/40-pdb.yaml \
  -f k8s/50-ingress.yaml -f k8s/51-ingress-sse.yaml
```

## 2. 跨文件取值不变量（改任意一个都要连带核对）

| 不变量 | 原因 |
| --- | --- |
| `SHUTDOWN_TIMEOUT_MS`(25s) + preStop(8s) **<** `terminationGracePeriodSeconds`(60s) | 否则排空没走完就被 SIGKILL，在途请求照样被切断 |
| 后端 `KEEP_ALIVE_TIMEOUT_MS`(75s) **>** 网关上游空闲超时（ingress-nginx 默认 60s） | 后端先关空闲连接 → 网关往死 socket 发请求 → 无痕 502（详见根目录 README「前置反向代理」） |
| `HEADERS_TIMEOUT_MS`(80s) **>** `KEEP_ALIVE_TIMEOUT_MS`(75s) | Node 对此不报错、静默接受，故 app 在配置层显式拦（反序会启动失败） |
| 探针 `timeoutSeconds`(2s) ≈ app 内探活超时(2s) | 依赖假死时 app 自己先返回 503，而不是让探针超时后盲判 |
| `readinessProbe` → `/readyz`，`livenessProbe` / `startupProbe` → `/healthz` | liveness 探外部依赖会在依赖抖动时重启**全部** Pod（重启修不好 DB，只会放大故障） |
| `replicas`(3) > `minAvailable`(2) ≥ 1 | PDB 需留出可驱逐余量，否则节点排水会一直挂住 |
| `APP_VERSION` == 镜像 tag | 滚动更新后用 `GET /info` 核对线上实际构建 |

## 3. 集群侧还需核对（不在本目录，属 ingress-nginx 控制器配置）

- **`upstream-keepalive-timeout`（默认 60s）必须小于后端 `KEEP_ALIVE_TIMEOUT_MS`（75s）**。
  默认值已经安全；若有人把它调到 75s 以上，必须同步调大 `KEEP_ALIVE_TIMEOUT_MS`，否则重现
  「网关复用已关闭连接 → 502」。查看与修改：

  ```bash
  kubectl -n ingress-nginx get configmap ingress-nginx-controller -o yaml | grep -i keepalive
  ```

- 若前面还有云 LB / WAF，同样按「从外到内空闲超时递增、每跳留 5s 以上余量」核对。
- **PDB 不约束滚动更新**（滚动更新由 `maxUnavailable` 约束），它挡的是节点排水 / 批量驱逐与
  滚动更新叠加把全部实例一起打死。

## 4. 上线后验证（不看「没报错」就算过）

```bash
kubectl -n billy rollout status deploy/billy-server --timeout=300s

# 探针语义（Pod 内直连，绕开 Ingress；镜像内置 curl）
kubectl -n billy exec deploy/billy-server -- sh -c \
  'curl -fsS -X POST http://127.0.0.1:9989/monitor/health; echo; \
   curl -fsS http://127.0.0.1:9989/readyz; echo; \
   curl -fsS http://127.0.0.1:9989/info; echo'

# 滚动更新期间持续打请求，统计非 2xx（这是唯一能证明「不 502」的实验）
kubectl -n billy rollout restart deploy/billy-server
# 另开一个终端：
#   while true; do curl -s -o /dev/null -w "%{http_code}\n" https://api.example.com/config/get \
#     -X POST -H 'content-type: application/json' -d '{}'; sleep 0.2; done | sort | uniq -c

# 出现 502 时，先确认打到了哪个 upstream（Terminating 中的 Pod 是决定性证据）
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=200 | grep -E " 502 "
```

SSE 专项：挂着 `POST /sse/subscribe` 长连接做一次 `rollout restart`，客户端应当收到
`event: stream.shutdown` 后**自动重连**（而不是流静默失效）。

## 5. 已知缺口：运行镜像里跑不了数据库迁移 ⚠️

`apps/server` 的迁移入口目前**无法在生产镜像里执行**，三处叠加导致：

1. `data-source.ts` 在包根目录（不在 `src/`），`tsconfig.build.json` 只编译 `src` → 镜像里没有它；
2. 它的 glob 指向 `src/database/migrations/*.{js,ts}`，而编译产物在 `dist/database/migrations/*.js`；
3. `db:migrate` 脚本用 `node --import tsx`，而 `tsx` 是 devDependency，`pnpm deploy --prod` 不会带上。

所以本清单里**没有**放迁移 Job：当前只能从构建环境（或一个带 devDependencies 的镜像）执行
`pnpm --filter @app/server run db:migrate`，再滚动更新。要把它做成标准的
`Job`/`initContainer`（编译出 `dist/data-source.js` + 用镜像内已有的 typeorm CLI 跑
`migration:run`），需要另行改造 `data-source` 的构建与脚本——这是独立的一件事，尚未做。

## 6. 飞书 CLI 连接器的状态落在 Pod 本地

server 镜像默认预装 `lark-cli`（`docker/Dockerfile.server`）。连接器「飞书 CLI」的 App 配置与
用户 token 在 `$HOME/.billy/lark-cli/<实例 id>`（容器里 `HOME=/home/appuser`）：

- **单副本 / 本地 compose**：`docker-compose.yaml` 已挂 `lark-cli-data:/home/appuser/.billy`，重建容器不丢授权；
- **K8s 多副本（当前 `replicas: 3`）**：每个 Pod 各一份本地状态，没有共享卷时**每个 Pod 都要单独授权**，
  且 Pod 重建后授权丢失。要长期用，给 `/home/appuser/.billy` 挂 RWX PVC（或改成单副本 + `Recreate`），
  否则只适合"先跑通"的验证阶段；
- 删连接器只删本地目录，**不撤销飞书侧的授权**；需要撤销时在飞书后台处理。
