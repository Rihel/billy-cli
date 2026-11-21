/**
 * 按 key 串行的小闸门（**进程内**）。
 *
 * 用途：同一个工作区里并发到达的两次写 —— 主 agent 与子 agent、并行工具调用、
 * 同一路径的写 / 替换 / 删除 —— 必须排队，否则后写者直接截断覆盖、读端还可能看到半截文件。
 *
 * 为什么是进程内而不是 Redis 锁：workspace-service 固定 1 副本（容器句柄、空闲回收都在内存里），
 * 要挡的恰恰是同一进程里并发的协程；跨副本语义本来就不成立，引入分布式锁只会多一套依赖。
 * 进程重启后闸门随内存清空 —— 那时也没有在途的并发写。
 *
 * 语义：`run(key, task)` 等待该 key 上的前一个 task 结束（成功或失败）再执行；
 * 不同 key 互不阻塞；key 上没有等待者时立刻执行。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<Result>(key: string, task: () => Promise<Result>): Promise<Result> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** 当前有排队的 key 数（测试与排障用；空闲时应为 0） */
  size(): number {
    return this.tails.size
  }
}
