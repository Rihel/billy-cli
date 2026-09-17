'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * SSE 连接状态（与 `@repo/http-client` 的 `StreamClientState` 字面量一致）。
 *
 * 刻意**不 import** `@repo/http-client`：`@repo/ui` 是表现层库，依赖传输包会把它
 * 绑死在某个 HTTP 客户端上，调用方也就无法注入自定义实现（测试替身 / 其他流协议）。
 * 类型重复一份的代价，换来 `@repo/ui` 不依赖任何网络层（依赖方向见
 * `packages/ui` → 无）。
 */
export type StreamState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed'

/**
 * `useStream` 需要的最小客户端契约（结构化接口）。
 *
 * `HttpStreamClient`（`@repo/http-client`）天然满足，无需适配器；
 * 测试里传一个手写替身即可。
 */
export interface StreamClientLike {
  /** 当前连接状态 */
  readonly currentState: string
  /** 订阅事件，返回取消订阅函数；内置状态事件名为 'open' / 'reconnecting' / 'closed' */
  on: (event: string, handler: (data: unknown) => void) => () => void
  /** 发起连接（仅 idle / closed 可调用） */
  connect: () => void
  /** 关闭连接（幂等） */
  close: () => void
}

/** 事件名 → 处理函数 */
export type StreamHandlers = Record<string, (data: unknown) => void>

export interface UseStreamResult {
  /** 连接状态（'open' 即已连上并保持） */
  state: StreamState
  /** 是否已连接（`state === 'open'` 的便捷判断） */
  connected: boolean
}

/** 内置状态事件名：客户端连接状态变化时按这些事件名分发 */
const STATE_EVENTS = ['open', 'reconnecting', 'closed'] as const

/**
 * 把 SSE 客户端接进 React 生命周期（通用前端能力，任何 app / 自定义客户端都能用）。
 *
 * 职责（只做 React 该做的事，不重复实现传输层能力）：
 * - 挂载建连、卸载 `close()`；`client` 引用变化时重连（**调用方用 `useMemo` 稳定引用**）；
 * - 订阅 `handlers` 声明的事件名，handler 存 ref —— 函数身份每次渲染变化**不会**触发重连，
 *   但始终调用最新实现；
 * - 订阅内置状态事件，把连接状态同步成 React state。
 *
 * 不负责（由 `HttpStreamClient` 承担）：页面隐藏断连 / 恢复重连、心跳、退避重连、
 * `Last-Event-ID`、服务端排空（`stream.shutdown`）后的重连。
 *
 * @param client 客户端实例；`null` / `undefined` 表示暂不建连（如未登录）
 * @param handlers 事件名 → 处理函数；**事件名集合变化会重建订阅**，故集合应稳定
 */
export function useStream(
  client: StreamClientLike | null | undefined,
  handlers: StreamHandlers = {},
): UseStreamResult {
  const [state, setState] = useState<StreamState>(
    () => (client?.currentState as StreamState | undefined) ?? 'idle',
  )

  const handlersRef = useRef(handlers)
  // 每次渲染后刷新 ref：即使不重建订阅，调用的也是最新的处理函数实现
  useEffect(() => {
    handlersRef.current = handlers
  })

  // 事件名集合的稳定指纹：只有集合变化才重建订阅（handler 实现变化不重建）
  const eventKey = Object.keys(handlers).sort().join('|')

  useEffect(() => {
    if (!client) {
      setState('idle')
      return
    }

    const unsubscribeList: Array<() => void> = []
    for (const event of eventKey ? eventKey.split('|') : []) {
      unsubscribeList.push(
        client.on(event, (data) => handlersRef.current[event]?.(data)),
      )
    }
    for (const event of STATE_EVENTS) {
      // 客户端在分发状态事件前已更新 currentState，故这里读到的是新状态
      unsubscribeList.push(client.on(event, () => setState(currentStateOf(client))))
    }

    client.connect()
    // connect 会把状态推进到 connecting，但这是**内部**状态（无对应事件），需主动同步一次
    setState(currentStateOf(client))

    return () => {
      // 先取消订阅再 close：close 会分发 'closed' 并清空监听器，
      // 先退订可避免在卸载后触发 setState
      for (const unsubscribe of unsubscribeList) unsubscribe()
      client.close()
    }
  }, [client, eventKey])

  return { state, connected: state === 'open' }
}

/** 读取客户端状态并收敛为 `StreamState`（未知值按 'idle' 处理，避免越界字符串泄漏到 UI） */
function currentStateOf(client: StreamClientLike): StreamState {
  const state = client.currentState
  return (STATE_EVENTS as readonly string[]).includes(state) ||
    state === 'idle' ||
    state === 'connecting'
    ? (state as StreamState)
    : 'idle'
}
