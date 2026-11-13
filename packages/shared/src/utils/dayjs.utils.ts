import dayjs, { OpUnitType, QUnitType, type ConfigType } from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import isoWeek from 'dayjs/plugin/isoWeek.js'
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter.js'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore.js'
import advancedFormat from 'dayjs/plugin/advancedFormat.js'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import zhCn from 'dayjs/locale/zh-cn.js'
import _ from 'lodash'
dayjs.locale(zhCn)
dayjs.extend(relativeTime)
dayjs.extend(isSameOrAfter)
dayjs.extend(isoWeek)
dayjs.extend(isSameOrBefore)
dayjs.extend(advancedFormat)
dayjs.extend(timezone)
dayjs.extend(utc)

export { dayjs, ConfigType }

export const isUnix = (v: number) => _.toString(v).length === 10

function adapterUnix(v: number) {
  if (isUnix(v)) {
    return dayjs.unix(v)
  }

  return dayjs(v)
}
export const standardTime = (v: ConfigType) => {
  if (typeof v === 'string' && /^\d+$/.test(v)) {
    return adapterUnix(_.toNumber(v))
  }
  if (typeof v === 'number') {
    return adapterUnix(v)
  }

  return dayjs(v)
}
export const formatTime = (v: ConfigType, format = 'YYYY-MM-DD HH:mm:ss') => {
  if (_.isNil(v)) return v
  return dayjs(standardTime(v)).format(format)
}

export const formatTimeInTimezone = (
  v: ConfigType,
  timezoneName: string,
  format = 'YYYY-MM-DD HH:mm:ss',
) => {
  if (_.isNil(v)) return v
  return standardTime(v).tz(timezoneName).format(format)
}

export const fromNow = (time: ConfigType) => {
  return dayjs(time).fromNow()
}

export function toUnix(date: ConfigType) {
  return dayjs(date).unix()
}

export const toTimeRange = (from: ConfigType, to: ConfigType) => {
  return [standardTime(from).startOf('D'), standardTime(to).endOf('D')]
}

export function calcDuration(start: ConfigType, end: ConfigType, unit?: QUnitType | OpUnitType) {
  const startTime = standardTime(start)
  const endTime = standardTime(end)
  let res = endTime.diff(startTime, unit, true)
  return Math.round(res * 10) / 10
}

export function parseTime(time: string) {
  const res = _.chain(time)
    .split(':')
    .compact()
    .map((item) => _.toNumber(item))
    .value()
  return { hour: res[0], minute: res[1] }
}

export function setDateTime(date: ConfigType, time: string) {
  date = standardTime(date)
  const { hour, minute } = parseTime(time)
  return dayjs(date).hour(hour).minute(minute).second(0)
}

export function createDayjsFromTime(time: string = '') {
  const { hour, minute } = parseTime(time)
  return dayjs().hour(hour).minute(minute)
}

export function rangeToTimeString(data: ConfigType[] = []) {
  return data.map((item) => {
    return formatTime(item, 'HH:mm')
  })
}
