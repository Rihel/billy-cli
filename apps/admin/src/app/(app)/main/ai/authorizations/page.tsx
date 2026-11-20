import { redirect } from 'next/navigation'

/** 服务授权已合并进能力服务（勾选条目 → 页面级「授权」），旧链接保留跳转 */
export default function AuthorizationsRedirectPage() {
  redirect('/main/ai/capabilities')
}
