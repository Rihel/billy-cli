/**
 * 告警业务配置（应用层，env 解析）：告警总开关 + 默认邮件接收人。
 * 通道接入点本身在通知模块（LarkConfig / NotifyConfig）。
 */
export const MonitorConfig = Symbol.for('MonitorConfig')

export interface MonitorConfig {
  /** 告警总开关：false 时 notifyError 直接跳过（默认 true） */
  enabled: boolean
  /** 邮件告警默认接收人（email 通道的 to；未配则 email 通道发送失败落日志） */
  emailTo?: string
}

export const monitorConfig: MonitorConfig = {
  enabled: process.env.ALERT_ENABLED !== 'false',
  emailTo: process.env.ALERT_EMAIL_TO || undefined,
}
