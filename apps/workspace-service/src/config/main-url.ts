/**
 * 生产部署必须显式配置 `MAIN_URL`。
 *
 * 为什么不在 zod schema 里做成必填：本地开发（`pnpm dev`）两个进程都在 127.0.0.1，
 * 要求每个开发者都配 `MAIN_URL` 是纯噪音，所以 schema 里保留了默认值
 * （`apps/workspace-service/src/config/app-config.ts` 的 `service.mainUrl`）。
 * 但默认值就意味着「缺配置也能启动、直到第一次凭据操作才 `fetch failed`」——
 * 容器里 127.0.0.1:9989 永远不是控制面。
 *
 * 所以把判定放在启动期：开发放行（回落默认），看起来是部署形态（生产 / 集群）就拒绝启动，
 * 把「静默错连」提前成「启动失败」。显式写了 `MAIN_URL`（哪怕是 127.0.0.1，自托管单机场景）
 * 一律放行 —— 我们拦的是「没配」，不是「配了本地地址」。
 */
export const productionMainUrlProblem = (env: NodeJS.ProcessEnv): string | null => {
  if (env.MAIN_URL?.trim()) return null
  const looksLikeDeployment = env.NODE_ENV === 'production' || Boolean(env.KUBERNETES_SERVICE_HOST)
  if (!looksLikeDeployment) return null
  return '必须配置 MAIN_URL（控制面地址，容器内如 http://main:9989 或 http://billy-main.billy.svc.cluster.local:80）：未配置会回落到 127.0.0.1:9989，凭据解析与凭据入库都会连不上'
}
