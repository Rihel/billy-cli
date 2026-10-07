import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import { afterEach, describe, expect, it } from 'vitest'
import { ModalForm } from '../src/components/modal-form.tsx'

/**
 * `ModalForm` 的**回填**（编辑弹窗的核心链路）。
 *
 * 为什么单独钉这条：`ModalForm` 的注释写着"传 `values` 时用 `form.setFieldValue` 逐字段写入
 * （**绕开 tanstack reset 的渲染同步问题**）"—— 也就是说 `values` 是它设计的回填入口。
 * 2026-10-07 的"编辑模型弹窗没有回填数据"就是**没走这个入口**（只 `form.reset()` 而不传 `values`），
 * 表现是所有字段一片空白。
 *
 * 这条测试盯的是"**给了 `values`，界面就真的显示它**"，而不是"函数被调用了"。
 */

interface Values extends Record<string, unknown> {
  name: string
  count?: number
  tags?: string[]
}

const Harness = ({ open, values }: { open: boolean; values?: Partial<Values> }) => {
  const form = useForm({ defaultValues: { name: '', count: undefined, tags: undefined } as Values })
  return (
    <ModalForm<Values>
      open={open}
      title="测试弹窗"
      form={form}
      onCancel={() => undefined}
      items={[
        {
          title: '信息',
          fields: [
            { name: 'name', label: '名称' },
            { name: 'count', label: '数量', widget: 'number' },
            {
              name: 'tags',
              label: '标签',
              render: ({ values: current }) => (
                <span data-testid="tags">{(current.tags ?? []).join(',')}</span>
              ),
            },
          ],
        },
      ]}
      values={values}
    />
  )
}

afterEach(cleanup)

describe('ModalForm 的回填', () => {
  it('打开时把 values 写进字段（内置控件）', async () => {
    render(<Harness open values={{ name: 'deepseek-flash', count: 32000 }} />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('deepseek-flash')).toBeTruthy()
    })
    expect(screen.getByDisplayValue('32000')).toBeTruthy()
  })

  it('**自定义 render 字段也拿到回填值**（它读的是表单 store 的 values）', async () => {
    render(<Harness open values={{ name: 'x', tags: ['text', 'image'] }} />)

    await waitFor(() => {
      expect(screen.getByTestId('tags').textContent).toBe('text,image')
    })
  })

  it('**不传 values 时没有任何回填入口**（这正是"编辑弹窗全空"的成因）', async () => {
    const { container } = render(<Harness open values={undefined} />)

    await waitFor(() => {
      expect(screen.getByTestId('tags').textContent).toBe('')
    })
    // 名称保持表单默认值（空）—— 不是"没渲染"，而是"没人把这一行的值写进来"
    const nameInput = container.querySelector('input[name="name"]')
    expect((nameInput as HTMLInputElement | null)?.value ?? '').toBe('')
  })
})
