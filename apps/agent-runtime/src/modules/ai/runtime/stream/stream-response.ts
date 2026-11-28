/**
 * 流式响应的最小抽象。
 *
 * 为什么单独成文件：Chat 执行体写 SSE、引擎层收事件流，两边都要这套类型与写帧工具。
 * 放在 `chat.service.ts` 里会让 `engine/run-execution.ts` 反向依赖执行体（运行时循环依赖）。
 */
export interface StreamResponseLike {
  writeHead: (status: number, headers: Record<string, string>) => unknown
  flushHeaders?: () => void
  write: (chunk: string) => unknown
  end: () => unknown
  status?: (code: number) => { end: () => unknown }
  writableEnded?: boolean
  on: (event: string, handler: () => void) => unknown
}

/** 输出记录里的"本轮结束"标记（补发连接见到它就收尾） */
export const STREAM_END_MARKER = '__run_end__'

export const UI_STREAM_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  // AG-UI 不认 vercel 的协议头（写了只会在排查时误导，手册 §8 坑 12）；只关网关缓冲
  'x-accel-buffering': 'no',
}

export const sseFrame = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`

/**
 * 向 SSE 响应写一帧（**客户端断开时不抛错**）。
 *
 * 为什么必须包一层：`ServerResponse.write()` 在 socket 已经关闭 / 响应已经 end 时会抛
 * 「Connection is closed.」。此前它直接出现在**心跳定时器**里 —— 定时器回调抛异常 = 进程级
 * `uncaughtException` = `process.exit(1)`，于是"一个客户端刷新页面"就能把整个服务重启，
 * 正在跑的其它会话跟着全丢（排查很久才定位到）。写失败只说明这一帧没人收，返回 false 即可。
 */
export const writeSse = (response: StreamResponseLike, chunk: string): boolean => {
  if (response.writableEnded) return false
  try {
    response.write(chunk)
    return true
  } catch {
    return false
  }
}

/** 结束 SSE 响应（幂等；客户端已断开时静默） */
export const endSse = (response: StreamResponseLike): void => {
  if (response.writableEnded) return
  try {
    response.end()
  } catch {
    // 连接已经没了：没有可收尾的对象
  }
}
