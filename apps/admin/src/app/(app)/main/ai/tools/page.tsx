import { redirect } from 'next/navigation'

/** 工具配置已并入「能力服务」的能力详情，旧入口保留重定向。 */
export default function AiToolsRedirectPage() {
  redirect('/main/ai/capabilities')
}
