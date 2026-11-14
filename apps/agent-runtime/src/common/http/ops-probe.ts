/**
 * 运维探针路径名单（k8s liveness / readiness 会按 `periodSeconds` 周期性调用）。
 *
 * 为什么要有这份名单：探针默认每 3s 一次、**每个 pod 都打**，若照常记录会
 * ① 日志被 `GET /readyz 503` 刷屏，真实请求淹没其中；
 * ② 计入 `request.count` / `request.error`，抬高 QPS，并在依赖故障时把「探针自己造成的
 * 503」算进错误率 —— 而错误率正是 监控指标告警的输入，会触发与真实业务无关的告警。
 *
 * 定义在 `common/` 而不是 ops 模块：中间件是横切层，不能反向依赖业务模块。
 * `/info` 不在此列：它是按需调用（非周期探针），要保留请求日志。
 */
export const OPS_PROBE_PATHS: readonly string[] = ['/healthz', '/readyz']

/**
 * 判定请求路径是否为运维探针。
 *
 * 归一化掉查询串与结尾斜杠，使 `/readyz?verbose=1`、`/readyz/` 与 `/readyz` 等价。
 */
export const isOpsProbePath = (path: string | undefined): boolean => {
  if (!path) return false
  const normalized = path.split('?')[0].replace(/\/+$/, '') || '/'
  return OPS_PROBE_PATHS.includes(normalized)
}
