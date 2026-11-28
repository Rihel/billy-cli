/**
 * 按 key 计数的并发闸门（信号量）。
 *
 * 用途：同一个父 run 下最多同时跑 N 个子 agent；不同父 run 互不影响。
 *
 * 两条语义：
 * - 超限的调用**排队**，释放时把槽位**直接转交**给下一个等待者（`active` 不回落），
 *   避免"刚释放就被新来的抢走、等待者反而被插队"；
 * - `active` 因此算的是"持有者 + 已转交但尚未恢复执行的等待者"，任何时刻都不超过 `limit`。
 *
 * 纯内存：只在一个进程内保证。同一个父 run 由单实例持有（同一会话只允许一轮进行中），
 * 不需要跨副本语义；进程重启后闸门随内存清空，已结束的 run 不受影响。
 */
export class KeyedSemaphore {
  private readonly gates = new Map<string, Gate>()

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`并发闸门的 limit 必须是正整数，收到 ${limit}`)
    }
  }

  /** 拿一个槽位；超限就等到有人释放（或转交） */
  async acquire(key: string): Promise<void> {
    let gate = this.gates.get(key)
    if (!gate) {
      gate = { active: 0, waiters: [] }
      this.gates.set(key, gate)
    }
    if (gate.active < this.limit) {
      gate.active += 1
      return
    }
    await new Promise<void>((resolve) => gate!.waiters.push(resolve))
  }

  /** 释放槽位：有人排队就转交，否则减一；该 key 空了就把闸门摘掉（不无限增长） */
  release(key: string): void {
    const gate = this.gates.get(key)
    if (!gate) return
    const next = gate.waiters.shift()
    if (next) {
      next()
      return
    }
    if (gate.active > 0) gate.active -= 1
    if (gate.active === 0) this.gates.delete(key)
  }

  /** 该 key 当前占用数（测试与排障用） */
  activeOf(key: string): number {
    return this.gates.get(key)?.active ?? 0
  }
}

interface Gate {
  active: number
  waiters: Array<() => void>
}
