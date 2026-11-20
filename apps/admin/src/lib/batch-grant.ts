/**
 * 批量授权的纯判据（技能库 / 能力服务共用，`components/batch-grant-dialog.tsx` 消费）。
 *
 * 抽成纯函数而不是写在组件里，是为了能单测：
 * 「一个主体在已选条目上的授权状态」与「用户改过哪些主体」这两件事出错时，
 * 表现是**多授/漏收**，界面上看不出来，只能靠用例锁。
 */

/** 主体在已选条目上的授权状态 */
export type GrantState = 'all' | 'some' | 'none'

/** 用户动过的主体：'all' = 要授予，'none' = 要收回 */
export type DesiredGrants = Map<string, 'all' | 'none'>

/**
 * 某个主体在「已选条目」上的状态。
 *
 * - `all`：每个被选条目都授权了它；
 * - `some`：只有部分条目授权了它（半选，点一下 = 全部授予）；
 * - `none`：一个都没有。
 */
export const grantStateOf = (
  granted: Map<string, Set<string>> | undefined,
  itemIds: string[],
  principalId: string,
): GrantState => {
  if (!granted || itemIds.length === 0) return 'none'
  let hits = 0
  for (const id of itemIds) {
    if (granted.get(id)?.has(principalId)) hits += 1
  }
  if (hits === 0) return 'none'
  return hits === itemIds.length ? 'all' : 'some'
}

/** 把「用户动过的状态」拆成接口需要的两份差量 */
export const splitDesired = (desired: DesiredGrants): { add: string[]; remove: string[] } => {
  const add: string[] = []
  const remove: string[] = []
  for (const [principalId, state] of desired) {
    if (state === 'all') add.push(principalId)
    else remove.push(principalId)
  }
  return { add, remove }
}
