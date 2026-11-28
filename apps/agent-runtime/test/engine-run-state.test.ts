import { describe, expect, it } from 'vitest'
import {
  canTransitionRunState,
  isRunState,
  isTerminalRunState,
} from '../src/modules/ai/engine/run-state.js'

describe('Run 状态机', () => {
  it('设计文档 §4.3 的每条边都合法', () => {
    const legal: Array<[string, string]> = [
      ['pending', 'running'],
      ['pending', 'canceled'],
      ['pending', 'failed'],
      ['running', 'suspended'],
      ['running', 'succeeded'],
      ['running', 'failed'],
      ['running', 'canceled'],
      ['running', 'interrupted'],
      ['suspended', 'running'],
      ['suspended', 'canceled'],
      ['suspended', 'failed'],
      ['interrupted', 'running'],
      ['interrupted', 'canceled'],
      ['interrupted', 'failed'],
    ]
    for (const [from, to] of legal) {
      expect(canTransitionRunState(from, to), `${from} → ${to}`).toBe(true)
    }
  })

  it('非法边不放过（含"终态复活"与未知状态）', () => {
    expect(canTransitionRunState('pending', 'suspended')).toBe(false)
    expect(canTransitionRunState('pending', 'succeeded')).toBe(false)
    expect(canTransitionRunState('succeeded', 'running')).toBe(false)
    expect(canTransitionRunState('failed', 'canceled')).toBe(false)
    expect(canTransitionRunState('canceled', 'running')).toBe(false)
    expect(canTransitionRunState('suspended', 'succeeded')).toBe(false)
    expect(canTransitionRunState('running', 'pending')).toBe(false)
    expect(canTransitionRunState('done', 'running')).toBe(false)
  })

  it('终态判定与状态识别', () => {
    for (const state of ['succeeded', 'failed', 'canceled']) {
      expect(isTerminalRunState(state)).toBe(true)
      expect(isRunState(state)).toBe(true)
    }
    for (const state of ['pending', 'running', 'suspended', 'interrupted']) {
      expect(isTerminalRunState(state)).toBe(false)
      expect(isRunState(state)).toBe(true)
    }
    expect(isRunState('running')).toBe(true)
    expect(isRunState('unknown')).toBe(false)
    expect(isRunState('')).toBe(false)
  })
})
