import { describe, expect, it } from 'vitest'
import { ToolDeniedError } from '../../src/modules/ai/core/tools/tools.types.js'
import { toErrorText } from '../../src/modules/ai/mastra/error.adapter.js'
import { ToolOutcomeError } from '../../src/modules/ai/mastra/tool.adapter.js'

/**
 * 错误结论**只能包含原因和提示**，不允许把内部堆栈带到模型/前端可见的地方。
 *
 * 触发点：web-fetch/web-request 访问不到目标站点时，之前会在错误卡片里露出
 * 一长串 `wrapFetchError → fetchGuarded → processTicksAndRejections` 堆栈。
 */
describe('工具错误不暴露堆栈', () => {
  it('ToolDeniedError 的 stack 应为空（业务拒绝）', () => {
    const err = new ToolDeniedError(
      'invalid-input',
      '拒绝访问 127.0.0.1：这是内网 / 回环 / 保留地址',
      '要抓本机服务请打开 allowPrivateNetwork',
    )
    expect(err.stack).toBeUndefined()
    expect(err.message).toContain('拒绝访问')
    expect(err.hint).toContain('allowPrivateNetwork')
  })

  it('ToolOutcomeError 的 stack 也应为空（网关→适配器抛出给 Mastra 的那一层）', () => {
    const err = new ToolOutcomeError('invalid-input', '请求失败：example.com', '换一个来源')
    expect(err.stack).toBeUndefined()
    expect(err.message).toBe('请求失败：example.com（换一个来源）')
    expect(err.reason).toBe('invalid-input')
  })
})

/**
 * `toErrorText` 是 `toUiStream` 的 `onError`：上游默认把错误对象 `JSON.stringify` 进 `errorText`，
 * durable 下错误回来时已是 `{ name, message, stack }` 普通对象，于是错误卡片里整段 JSON + 堆栈。
 */
describe('toErrorText（适配器：错误卡片只放结论）', () => {
  it('durable 下回来的普通对象：只取 message，不带 stack', () => {
    const text = toErrorText({
      name: 'Error',
      message: '请求失败：https://duckduckgo.com（Connect Timeout Error）',
      stack: 'Error: 请求失败：...\n    at Object.execute (…@mastra/core/dist/utils.js:621:25)',
    })
    expect(text).toBe('请求失败：https://duckduckgo.com（Connect Timeout Error）')
    expect(text).not.toContain('at Object.execute')
  })

  it('非 durable 的 MastraError（Error 实例）：取 message，不取 JSON', () => {
    const wrapped = Object.assign(new Error('请求失败：example.com（连接超时）'), {
      id: 'TOOL_EXECUTION_FAILED',
      cause: { message: '内部细节', name: 'ToolOutcomeError' },
      details: { errorMessage: 'ToolOutcomeError: 内部细节' },
    })
    expect(toErrorText(wrapped)).toBe('请求失败：example.com（连接超时）')
  })

  it('字符串错误原样返回（去掉首尾空白）', () => {
    expect(toErrorText('  模型调用失败  ')).toBe('模型调用失败')
  })

  it('没有说明时给兜底文案（不返回 "{}" / "[object Object]" / "null"）', () => {
    expect(toErrorText(new Error('   '))).toBe('执行失败（错误对象没有说明原因）')
    expect(toErrorText(null)).toBe('执行失败（错误对象没有说明原因）')
    expect(toErrorText({ stack: 'at foo' })).not.toContain('foo')
  })
})
