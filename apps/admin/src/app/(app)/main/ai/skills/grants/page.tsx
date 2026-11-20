import { redirect } from 'next/navigation'

/** 技能授权已合并进技能库（勾选条目 → 页面级「授权」），旧链接保留跳转，避免书签 404 */
export default function SkillGrantsRedirectPage() {
  redirect('/main/ai/skills')
}
