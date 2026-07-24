import dayjs, { type ConfigType } from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import isoWeek from 'dayjs/plugin/isoWeek.js'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js'
import advancedFormat from 'dayjs/plugin/advancedFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import zhCn from 'dayjs/locale/zh-cn.js'
dayjs.locale(zhCn)
dayjs.extend(relativeTime)
dayjs.extend(isSameOrAfter)
dayjs.extend(isoWeek)
dayjs.extend(isSameOrBefore)
dayjs.extend(advancedFormat)
dayjs.extend(timezone)
dayjs.extend(utc)

export { dayjs, ConfigType }

export function formatTime(time?: ConfigType, format = 'YYYY-MM-DD HH:mm:ss') {
  return dayjs(time).format(format)
}
