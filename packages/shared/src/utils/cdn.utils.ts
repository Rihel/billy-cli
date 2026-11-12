/**
 * 沙箱预览（AI 写的 HTML 页面）允许加载的公开 CDN。
 *
 * 一份清单两个消费方，所以放 shared，不各写一份：
 * 1. `packages/ui` 的沙箱 CSP —— 只放行这几家的脚本 / 样式 / 图片 / 字体；
 * 2. `apps/server` 的提示词守卫测试 —— 提示词里教的 CDN 必须与白名单完全一致。
 *
 * **顺序就是提示词里的兜底顺序**：国内（npmmirror，任意 npm 包）→ 海外（jsDelivr）→ 兜底（unpkg）。
 * 三家都能按「包内路径」取到同一个文件，差别只在 URL 前缀与版本写法：
 *
 * ```
 * https://registry.npmmirror.com/<包名>/<版本>/files/<包内路径>
 * https://cdn.jsdelivr.net/npm/<包名>@<版本>/<包内路径>
 * https://unpkg.com/<包名>@<版本>/<包内路径>
 * ```
 *
 * 取这三家的理由（2026-11-12 实测 `echarts@5.4.3` 均 200、内容一致）：npmmirror 是国内镜像、
 * 覆盖全部 npm 包且国内快；jsDelivr / unpkg 覆盖全部 npm 包、海外可达；老牌国产 CDN
 * （staticfile / bootcdn）只收录热门库且路径规则不同，不作为默认。
 *
 * **增删主机时三处一起改**：本文件、`requirements.eta` 的 CDN 段、两个包各自的测试。
 */
export const SANDBOX_CDN_HOSTS = [
  'registry.npmmirror.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
] as const
