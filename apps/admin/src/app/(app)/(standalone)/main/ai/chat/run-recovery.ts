'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai'
import type { AgentRunSnapshotModel } from '@repo/shared'
import { agUiSseToChunkStream, markTransientChunks } from './chat-transport'

/**
 * 断线恢复流（手册 §7.2）：**快照 + `sinceRev` 增量**，不是 SDK 的整轮重放。
 *
 * 为什么单独一个 hook：
 * - `useChat({ resume: true })` 只能拿到一条 SSE，拿不到"先渲染快照"；
 * - 恢复流不是 `useChat` 的流，`status` / `runId` 不会自己回来 —— 必须显式 `onRun`；
 * - 恢复出来的消息要独立活到收尾，再并回 `messages`（§7.3 的顺序问题）。
 *
 * 三个关键点：
 * 1. 先用 `loadSnapshot()` 问"有没有进行中的轮"：`null` 就什么都不做（不点亮"恢复中"）；
 * 2. 快照 parts 作为 `readUIMessageStream` 的种子消息；流从 `sinceRev` 开始，
 *    因此**不会把快照内容再发一遍**；
 * 3. 流里的 data 块（`data-run` / 子助手状态 / 标题）旁路给 `onChunk`，
 *    与 `useChat.onData` 共用同一套处理。
 */
/**
 * 把恢复出来的 assistant 消息并回列表：**同 id 原位替换，没有才追加**。
 *
 * 不要"先删同 id 再 push"：恢复结束时用户可能已经能发下一条，追加到末尾会把 AI 回答
 * 排到新 user 后面（`[user1, user2, AI]`，手册 §7.3）。
 */
export const mergeAssistantMessage = (messages: UIMessage[], live: UIMessage): UIMessage[] => {
  const at = messages.findIndex((message) => message.id === live.id)
  if (at < 0) return [...messages, live]
  const next = messages.slice()
  next[at] = live
  return next
}

export interface UseRunRecoveryOptions {
  enabled: boolean
  /** 会话 / 轮次切换时重置（换会话必须重新取快照） */
  reloadKey?: string
  loadSnapshot: () => Promise<AgentRunSnapshotModel | null>
  streamUrl: (sinceRev: number) => string
  headers: () => Promise<Record<string, string>>
  /** 恢复消息每次更新（seed 与增量都走这里） */
  onMessage: (message: UIMessage) => void
  /** data 块旁路（与 `useChat` 的 `onData` 同一处理） */
  onChunk?: (chunk: UIMessageChunk) => void
  /** 快照到手 = 确实有一轮在跑：把 runId 接回页面状态 */
  onRun?: (runId: string) => void
  onError?: (error: unknown) => void
}

export interface RunRecoveryState {
  /** 正在恢复（页面据此并入 streaming / 停止按钮） */
  active: boolean
  /** 手动触发一次（排队 / 唤醒轮起跑后由上层调用） */
  start: () => void
}

export const useRunRecovery = (options: UseRunRecoveryOptions): RunRecoveryState => {
  const [active, setActive] = useState(false)
  const optionsRef = useRef(options)
  // 渲染期不写 ref：放到 effect 里（晚一帧，`start` 在 effect 之后触发，拿到的已是最新值）
  useEffect(() => {
    optionsRef.current = options
  })

  /** 当前恢复的序号：换会话 / 关闭时 +1，旧协程据此安静退出 */
  const sequenceRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const startingRef = useRef(false)

  const stop = useCallback((): void => {
    sequenceRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    startingRef.current = false
    setActive(false)
  }, [])

  const start = useCallback((): void => {
    if (startingRef.current || controllerRef.current) return
    startingRef.current = true
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence

    void (async () => {
      /**
       * `readUIMessageStream` 每个 chunk 都会产出一版消息；逐版 `setState` 会按 token 数
       * 重渲染整条会话。与 `useChat` 的 `experimental_throttle` 同口径：60ms 合并一次，
       * 收尾时强制 flush，保证最后一版一定到。
       */
      let pending: UIMessage | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      const flush = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (!pending) return
        const next = pending
        pending = null
        optionsRef.current.onMessage(next)
      }
      const emit = (message: UIMessage): void => {
        pending = message
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          const next = pending
          pending = null
          if (next) optionsRef.current.onMessage(next)
        }, 60)
      }

      try {
        const snapshot = await optionsRef.current.loadSnapshot()
        if (sequence !== sequenceRef.current) return
        // 没有进行中的轮：不打开流、也不点亮"恢复中"
        if (!snapshot) return

        const controller = new AbortController()
        controllerRef.current = controller
        const response = await fetch(optionsRef.current.streamUrl(snapshot.sinceRev), {
          headers: await optionsRef.current.headers(),
          signal: controller.signal,
        })
        if (sequence !== sequenceRef.current) return
        if (response.status === 204 || !response.body) return
        if (!response.ok) throw new Error(`恢复流请求失败（HTTP ${response.status}）`)

        optionsRef.current.onRun?.(snapshot.runId)
        setActive(true)
        /**
         * 种子 = 快照里已闭合的 parts；`sinceRev > 0` 时服务端只补之后的事件。
         * `sinceRev = 0`（还没有任何记录）时不给种子，让流自己从 `start` 建消息。
         */
        const seed: UIMessage = {
          id: snapshot.messageId,
          role: 'assistant',
          parts: (snapshot.sinceRev > 0 ? snapshot.parts : []) as UIMessage['parts'],
        }
        optionsRef.current.onMessage(seed)

        const chunks = markTransientChunks(agUiSseToChunkStream(response.body))
        const [forMessage, forData] = chunks.tee()
        // 旁路消费：data 块（子助手增量 / runId / 标题）不参与消息归约
        void (async () => {
          try {
            for await (const chunk of forData) optionsRef.current.onChunk?.(chunk)
          } catch {
            // 主分支的 readUIMessageStream 会把错误交给 onError
          }
        })()

        for await (const message of readUIMessageStream({ message: seed, stream: forMessage })) {
          if (sequence !== sequenceRef.current) return
          emit(message)
        }
        flush()
      } catch (error) {
        if (sequence === sequenceRef.current && !controllerRef.current?.signal.aborted) {
          optionsRef.current.onError?.(error)
        }
      } finally {
        // 换会话 / 停止：丢掉未提交的那一版，别让定时器在卸载后再写状态
        if (sequence !== sequenceRef.current) {
          if (timer) clearTimeout(timer)
          timer = null
          pending = null
        } else {
          // 收尾 / 异常都要把最后一版交出去，否则恢复内容会停在 60ms 前
          flush()
        }
        startingRef.current = false
        if (sequence === sequenceRef.current) {
          controllerRef.current = null
          setActive(false)
        }
      }
    })()
  }, [])

  useEffect(() => {
    if (!options.enabled) {
      stop()
      return
    }
    start()
    return stop
  }, [options.enabled, options.reloadKey, start, stop])

  return { active, start }
}
