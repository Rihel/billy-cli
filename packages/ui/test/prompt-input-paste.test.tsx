import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PromptInput, PromptInputTextarea } from '../src/components/ai-elements/prompt-input.tsx'

/**
 * 粘贴长文本 → 直接变附件、输入框留空。
 *
 * 这是"用户复制一段日志进来"的主路径：他随后要写的是自己的问题，
 * 长文不该糊满输入框；同时短片段不能被误转成附件。
 */
afterEach(() => {
  cleanup()
})

const paste = (element: HTMLElement, init: Record<string, unknown>) => {
  fireEvent.paste(element, { clipboardData: init })
}

const renderTextarea = (onConverted = vi.fn(), minChars = 10) => {
  render(
    <PromptInput onSubmit={() => {}}>
      <PromptInputTextarea
        pasteTextAsAttachment={{
          minChars,
          toFile: (text) => new File([text], '长文本.md', { type: 'text/markdown' }),
          onConverted,
        }}
      />
    </PromptInput>,
  )
  return { textarea: screen.getByRole('textbox') as HTMLTextAreaElement, onConverted }
}

describe('PromptInputTextarea：长文本粘贴转附件', () => {
  it('超过阈值：生成附件、回调一次，文本不留在输入框', () => {
    const { textarea, onConverted } = renderTextarea()
    const long = 'a'.repeat(20)

    paste(textarea, { items: [], types: ['text/plain'], getData: () => long })

    expect(onConverted).toHaveBeenCalledTimes(1)
    const file = onConverted.mock.calls[0]?.[0] as File
    expect(file.name).toBe('长文本.md')
    expect(file.type).toBe('text/markdown')
    expect(textarea.value).toBe('')
  })

  it('短文本：不转附件（保持默认插入行为）', () => {
    const { textarea, onConverted } = renderTextarea()

    paste(textarea, { items: [], types: ['text/plain'], getData: () => '十几字的短问题' })

    expect(onConverted).not.toHaveBeenCalled()
  })

  it('带文件的粘贴优先按文件处理，不把同一份文本也转成附件', () => {
    const { textarea, onConverted } = renderTextarea()
    const image = new File(['x'], 'a.png', { type: 'image/png' })

    paste(textarea, {
      items: [{ kind: 'file', getAsFile: () => image }],
      types: ['Files'],
      getData: () => 'a'.repeat(20),
    })

    expect(onConverted).not.toHaveBeenCalled()
  })
})
