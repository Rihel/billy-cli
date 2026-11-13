'use client'

import { cn } from '#lib/utils.ts'
import { Avatar, AvatarFallback, AvatarImage } from '#components/ui/avatar.tsx'

export type UserAvatarProps = {
  /** 头像地址（调用方先拼成可访问 URL）；为空或加载失败时用首字符兜底 */
  src?: string | null
  /** 姓名或邮箱：取首字符作为兜底内容（中文取第一个字，英文取首字母大写） */
  name?: string | null
  /** 无障碍描述，缺省用 name */
  alt?: string
  size?: 'sm' | 'default' | 'lg'
  /** 形状：列表/侧栏用 rounded 方块，默认圆形 */
  shape?: 'circle' | 'rounded'
  className?: string
}

/**
 * 取兜底首字符。
 *
 * 用 `Array.from` 而不是 `[0]`：表情与部分汉字是代理对，按 UTF-16 下标取会截成半个字符。
 * 英文统一大写，中文原样。
 */
function initialOf(name?: string | null): string {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return '?'
  const first = Array.from(trimmed)[0] ?? '?'
  return /[a-z]/i.test(first) ? first.toUpperCase() : first
}

/**
 * 用户头像：有图显示图，没图用「首字符 + 品牌色底」。
 *
 * 为什么收成一个组件：头像的兜底规则（取哪个字、什么底色、圆角多大）散在三处页面里时，
 * 改一次要改三遍、还会出现「侧栏是方块、表格是圆形、有的干脆不显示」的分叉。
 * 底色走 `--brand`（系统主色），深色模式下同样成立。
 */
export function UserAvatar({
  src,
  name,
  alt,
  size = 'default',
  shape = 'circle',
  className,
}: UserAvatarProps) {
  const rounded = shape === 'rounded'
  return (
    <Avatar size={size} className={cn(rounded && 'rounded-lg after:rounded-lg', className)}>
      {src ? <AvatarImage src={src} alt={alt ?? name ?? ''} /> : null}
      <AvatarFallback
        className={cn('bg-brand font-medium text-white select-none', rounded && 'rounded-lg')}
        aria-hidden={!name}
      >
        {initialOf(name)}
      </AvatarFallback>
    </Avatar>
  )
}
