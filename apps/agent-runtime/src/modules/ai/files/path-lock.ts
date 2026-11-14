/**
 * 按 key 串行的小闸门（进程内）。
 *
 * workspace 的写 / 替换 / 追加 / 提交都走它：同一路径一次只做一件事，
 * 避免模型并行发工具调用时读到半截文件、或提交到一半的内容。
 * 跨副本不保证（workspace 本来就是本地盘）。
 */
export class PathLock {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
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
}
