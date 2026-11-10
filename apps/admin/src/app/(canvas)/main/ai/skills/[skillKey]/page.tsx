'use client'

import { useParams } from 'next/navigation'
import { SkillEditor } from './skill-editor'

/** 技能编辑器（全窗口画布）：只负责从路由取 skillKey。 */
export default function SkillCanvasPage() {
  const params = useParams<{ skillKey: string }>()
  const skillKey = decodeURIComponent(String(params.skillKey))
  return <SkillEditor skillKey={skillKey} />
}
