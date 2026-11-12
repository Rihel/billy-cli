import { createDict } from '../utils/dict.utils'

/**
 * 分享链接的有效期档位。
 *
 * `value` 是**档位标识**而不是秒数：秒数由 `shareTtlSeconds` 统一换算，
 * 接口只认秒数（`expiresIn`），这样前端换档位不需要后端改。
 */
export const ShareTtl = createDict({
  OneHour: { label: '1 小时', value: '1h' },
  OneDay: { label: '1 天', value: '1d' },
  SevenDays: { label: '7 天', value: '7d' },
  ThirtyDays: { label: '30 天', value: '30d' },
  Permanent: { label: '永久有效', value: 'permanent' },
})

export type ShareTtlValue = (typeof ShareTtl)['options'][number]['value']

/** 档位 → 秒数；`permanent` → null（永久） */
export const shareTtlSeconds = (value: string): number | null => {
  switch (value) {
    case ShareTtl.OneHour:
      return 60 * 60
    case ShareTtl.OneDay:
      return 24 * 60 * 60
    case ShareTtl.SevenDays:
      return 7 * 24 * 60 * 60
    case ShareTtl.ThirtyDays:
      return 30 * 24 * 60 * 60
    case ShareTtl.Permanent:
      return null
    default:
      return 7 * 24 * 60 * 60
  }
}
