/**
 * 子 agent 运行状态 → 人话 / 徽标样式。
 *
 * 为什么单拎一个文件：`statusLabel` 被卡片、tab 条、右栏、过程视图四处共用；
 * 留在 `sub-agent-panel.tsx` 里会让「过程视图 → ChatMessage → 子助手卡 → 过程视图」成环
 * （2026-11-21 `oxlint import/no-cycle` 实测报错）。
 */

/** 运行状态 → 人话（卡片、tab 与运行记录都用这一份，口径不分叉） */
export const statusLabel: Record<string, string> = {
  pending: '排队中',
  running: '进行中',
  suspended: '等待回答',
  succeeded: '已完成',
  failed: '失败',
  interrupted: '已中断',
  canceled: '已停止',
  rejected: '未执行',
}

export const statusVariant = (
  status?: string,
): 'default' | 'secondary' | 'destructive' | 'outline' => {
  if (status === 'succeeded') return 'default'
  if (status === 'failed') return 'destructive'
  if (status === 'running') return 'secondary'
  return 'outline'
}
