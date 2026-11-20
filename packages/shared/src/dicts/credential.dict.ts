import { createDict } from '../utils'

/**
 * 个人凭据的四个字典（`docs/design/workspace-cli-credentials.md` §6.4.1）。
 *
 * 四个维度刻意分开，别合并成一个"类型"：
 * - `kind`：**生命周期语义**（能不能刷新），不表达"是哪种资源"（那是 `provider` + `template`）；
 * - `lifetime`：库里记录的有效期口径（长期 / 临时）；
 * - `refresh`：临时凭据由谁续期；
 * - `status`：只表达**确定性失效**（吊销 / 上游明确拒绝），网络故障不得置为 `expired`。
 */

/** 凭据种类：静态（不刷新）/ OAuth（可刷新）/ SSH 私钥（v1 预留，不开放） */
export const CredentialKind = createDict({
  Static: { label: '静态凭据', value: 'static' },
  Oauth: { label: '授权凭据', value: 'oauth' },
  SshKey: { label: 'SSH 私钥', value: 'ssh-key' },
})

/** 有效期口径：长期 / 临时（临时必须填 `expiresAt`） */
export const CredentialLifetime = createDict({
  LongTerm: { label: '长期', value: 'long-term' },
  Temporary: { label: '临时', value: 'temporary' },
})

/** 刷新方式：仅对 `temporary` 有意义 */
export const CredentialRefresh = createDict({
  Oauth: { label: '平台自动续期', value: 'oauth' },
  Manual: { label: '需用户重新提供', value: 'manual' },
  External: { label: '外部系统签发', value: 'external' },
  None: { label: '不刷新', value: 'none' },
})

/** 凭据状态：`expired` 只在确定性失败时写入 */
export const CredentialStatus = createDict({
  Active: { label: '可用', value: 'active' },
  Expired: { label: '已失效', value: 'expired' },
  Revoked: { label: '已吊销', value: 'revoked' },
})

/**
 * 审计动作（§6.4.8）：每一次读取、刷新、导入、吊销与拒绝都要留痕。
 *
 * 独立成表而不是塞进主表：审计是追加写，混入主表会让热行持续膨胀、拖慢每次解析。
 */
export const CredentialAuditAction = createDict({
  Issue: { label: '绑定 / 签发', value: 'issue' },
  Refresh: { label: '刷新', value: 'refresh' },
  Revoke: { label: '吊销', value: 'revoke' },
  Import: { label: '导入', value: 'import' },
  Resolve: { label: '读取', value: 'resolve' },
  Deny: { label: '拒绝', value: 'deny' },
})

/** 审计里的消费方标识（谁取用了这份凭据） */
export const CredentialAuditConsumer = createDict({
  WorkspaceService: { label: '工作区执行面', value: 'workspace-service' },
  CapabilityGateway: { label: '能力网关', value: 'capability-gateway' },
  Web: { label: '管理端', value: 'web' },
  Main: { label: '控制面', value: 'main' },
})
