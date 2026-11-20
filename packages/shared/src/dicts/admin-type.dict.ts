import { createDict } from '../utils'

/**
 * 管理员类型（`docs/design/workspace-cli-credentials.md` §6.10）。
 *
 * 只有两级、不做层级树：
 * - `normal` 普通管理员：管平台配置，个人资源（凭据 / 技能 / 会话 / 工作区）只碰自己的；
 * - `god` 超级管理员：在普通管理员之上，可在留痕（审计）前提下跨主体查看元数据与启停资源。
 *
 * **命名约定**：JWT 的 `type` 已经表示 token 类型（见 `ADMIN_TOKEN_TYPE`），
 * 因此管理员类型在会话负载、claim 与实体属性里统一叫 `adminType`，避免两个 `type` 混淆。
 */
export const AdminType = createDict({
  Normal: { label: '普通管理员', value: 'normal' },
  God: { label: '超级管理员', value: 'god' },
})

/** 管理员类型取值联合（写库 / 会话负载 / 归属过滤共用） */
export type AdminTypeValue = 'normal' | 'god'

/** 全部取值，顺序即表单顺序 */
export const ADMIN_TYPES: readonly AdminTypeValue[] = ['normal', 'god']

/** 缺省类型：普通管理员（最小权限） */
export const DEFAULT_ADMIN_TYPE: AdminTypeValue = 'normal'

/**
 * 把任意输入收敛成合法类型（**默认最小权限**）。
 *
 * 用途：读旧会话（升级前登记的会话没有 `adminType`）与读库里的字符串列时，
 * 认不出的值一律按 `normal` 处理 —— 宁可少给权限，也不能把脏值当超管放行。
 */
export const toAdminType = (value: unknown): AdminTypeValue =>
  ADMIN_TYPES.includes(value as AdminTypeValue) ? (value as AdminTypeValue) : DEFAULT_ADMIN_TYPE
