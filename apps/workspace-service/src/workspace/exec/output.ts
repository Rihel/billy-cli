/** 单次命令输出的默认硬上限（字节）；调用方可按请求再压小，不能超过这个值 */
export const MAX_EXEC_OUTPUT = 64 * 1024

/** 被截断时追加在末尾的提示（给模型看，别让它以为输出就这么多） */
export const TRUNCATED_MARK = '\n…（输出超过上限，后续内容已截断）'

/** 上限归一：既不能超过默认值，也不能小到没法看 */
export const resolveMaxOutput = (value: number | undefined): number =>
  Math.max(1024, Math.min(value ?? MAX_EXEC_OUTPUT, MAX_EXEC_OUTPUT))

/**
 * 命令输出收集器：**按字节**设上限，超出即停收并打标记。
 *
 * 为什么不「收完再截」：`docker exec` / `kubectl exec` 的输出是流式的，
 * 一个 `yes`、`cat /dev/urandom` 就能把进程内存打爆 —— 必须在数据到达时就停。
 */
export const createOutputCollector = (maxBytes: number) => {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    push(chunk: Buffer): void {
      if (truncated) return
      chunks.push(chunk)
      bytes += chunk.length
      if (bytes > maxBytes) truncated = true
    },
    /** 超限时按字节切（多字节字符在边界上可能留一个替换符，可接受） */
    text(): string {
      const raw = Buffer.concat(chunks)
      if (!truncated && raw.length <= maxBytes) return raw.toString('utf8')
      return `${raw.toString('utf8', 0, maxBytes)}${TRUNCATED_MARK}`
    },
    truncated: (): boolean => truncated,
  }
}
