/**
 * 凭据版本（`docs/design/workspace-cli-credentials.md` §6.4.6 的 `credentialVersion`）。
 *
 * 语义：**该主体当前凭据集合的指纹**。绑定 / 吊销 / 刷新都会让它变化，
 * 因此"工作区里的版本 ≠ 当前版本"就等价于"容器内的副本落后了"。
 *
 * 用 `数量 + 最大 version` 而不是维护一个全局自增计数器：`version` 是凭据行上的列，
 * **只在凭据真正变化时 +1**（绑定 / 刷新）；`last_used_at` 的触碰不参与，否则每次解析都会
 * 让版本变化、工作区永远"落后"（踩过）。
 *
 * 不做全局自增的原因：自增需要一张额外的表、
 * 且要在每次写入时保证原子 +1；而 `updated_at` 由库维护，天然单调、零维护。
 * 读这张表的两个地方（main 推送时、执行面 ensure 时）用同一个函数算，结果一致。
 */
export const credentialVersionOf = (rows: { version?: number | null }[]): string => {
  let max = 0
  for (const row of rows) {
    const version = row.version ?? 0
    if (Number.isFinite(version) && version > max) max = version
  }
  return `${rows.length}-${max}`
}
