/** 把上游 SSE 响应体持续读掉（背压），不解析帧：内容以 pub/sub 回投为准 */
export const drainStream = async (body: ReadableStream<Uint8Array>): Promise<void> => {
  const reader = body.getReader()
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    // 前端断开 / runtime 结束都正常；pub/sub 的 final 帧负责收尾
  }
}
