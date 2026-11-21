'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@repo/ui'
import {
  PromptInputTextarea,
  usePromptInputController,
  type PromptInputTextareaProps,
} from '@repo/ui/components/ai-elements/prompt-input.tsx'
import { SparklesIcon, XIcon } from 'lucide-react'
import { useServerClient } from '@/lib/server-client'
import {
  filterSkills,
  insertSkillToken,
  removeSkillToken,
  selectedSkillKeysOf,
  slashQueryOf,
} from './skill-slash'

/**
 * 输入框的**斜杠技能选择**（不是富文本：文本仍是普通文本，`/技能名` 就是一个词元）。
 *
 * 交互（产品口径）：
 * - `/` 是 `trim()` 后的**第一个字符**才弹菜单；继续打字按名字过滤；
 * - `↑` / `↓` 移动、`Enter` / `Tab` 插入、`Esc` 关闭；回车在菜单开着时**不发送**；
 * - 插入后把 `/技能名 ` 写进文本；已选技能的**标签**由 `SkillTags` 渲染在输入框**外面**的左上角
 *   （两者从同一份文本派生，删标签 = 删词元）；
 * - 发送时不额外带字段：服务端从文本里识别 `/技能名`（见 `requestedSkillsOf`）。
 *
 * 为什么不换富文本编辑器：标签只需要"能看见、能删"，用一份纯文本 + 一段派生标签
 * 就能做到；换编辑器要把附件 / 粘贴 / 长文本转附件 / 快捷键 / 移动端键盘全部重接一遍。
 */
/**
 * 已选技能的**标签条**：`PromptInput` 的兄弟节点（输入框外面，左上方）。
 *
 * 为什么不放进 `PromptInputBody`：`InputGroup` 是 `items-center` 的 flex 容器，
 * 块级子节点会被缩成内容宽度并居中（踩过：标签跑到输入框正中间）。
 *
 * 标签与文本**同源**：都从 `/技能名` 词元派生 —— 删标签就删词元，手动删词元标签也会消失。
 */
export function SkillTags() {
  const client = useServerClient()
  const controller = usePromptInputController()
  const text = controller.textInput.value

  const skillsQuery = useQuery({
    queryKey: ['ai', 'skill-catalog'],
    queryFn: () => client.aiSkill.list({ page: 1, size: 100 }),
    // 与菜单同一个 queryKey：开菜单时查过一次就命中缓存
    enabled: text.includes('/'),
  })

  const skills = useMemo(() => skillsQuery.data?.items ?? [], [skillsQuery.data])
  const knownKeys = useMemo(() => skills.map((skill) => skill.skillKey), [skills])
  const selected = useMemo(() => selectedSkillKeysOf(text, knownKeys), [text, knownKeys])
  if (selected.length === 0) return null

  const remove = (key: string): void => {
    controller.textInput.setInput(removeSkillToken(controller.textInput.value, key))
    document.querySelector<HTMLTextAreaElement>('textarea[name="message"]')?.focus()
  }

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1 px-1">
      {selected.map((key) => (
        <span
          key={key}
          className="inline-flex max-w-72 items-center gap-1 rounded-md bg-brand/10 px-1.5 py-0.5 text-xs text-brand"
        >
          <SparklesIcon className="size-3 shrink-0" />
          <span className="truncate" title={key}>
            {skills.find((skill) => skill.skillKey === key)?.title || key}
          </span>
          <button
            type="button"
            aria-label={`移除技能 ${key}`}
            title="移除技能"
            onClick={() => remove(key)}
            className="shrink-0 rounded-sm p-0.5 hover:bg-brand/15"
          >
            <XIcon className="size-3" />
          </button>
        </span>
      ))}
    </div>
  )
}

export function SkillSlashInput({
  placeholder,
  submitOn,
  pasteTextAsAttachment,
}: Pick<PromptInputTextareaProps, 'placeholder' | 'submitOn' | 'pasteTextAsAttachment'>) {
  const client = useServerClient()
  const controller = usePromptInputController()
  const text = controller.textInput.value
  const query = slashQueryOf(text)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  /**
   * 输入框本身：既是菜单的定位锚点，也是插入 / 删标签后还焦点的地方。
   *
   * **不要**再包一层 `div` 当锚点：`InputGroup` 是 `items-center` 的 flex 容器，
   * 多一层不吃 `flex-1` 的 block 会缩成内容宽度并被居中（表现为"文字跑到输入框中间"）。
   * React 19 起 `ref` 是普通 prop，会随 `...props` 落到真正的 `<textarea>` 上。
   */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /**
   * 菜单的定位锚点（`fixed` + portal）。
   *
   * 为什么必须走 portal：`PromptInput` 的 InputGroup 是 `overflow-hidden`，
   * 菜单绝对定位在输入框上方就会被裁掉（只露出输入框内部那一截）。
   * 用输入框的 `getBoundingClientRect()` 算「贴住输入框上沿、宽度同宽」。
   */
  const [anchor, setAnchor] = useState<{ left: number; width: number; bottom: number } | null>(null)

  const skillsQuery = useQuery({
    queryKey: ['ai', 'skill-catalog'],
    queryFn: () => client.aiSkill.list({ page: 1, size: 100 }),
    // 输入里出现 `/` 才查：普通对话不多发一个请求；右栏「技能」用同一个 queryKey，命中缓存
    enabled: text.includes('/'),
  })

  const skills = useMemo(() => skillsQuery.data?.items ?? [], [skillsQuery.data])
  const options = useMemo(() => filterSkills(skills, query ?? ''), [skills, query])
  const open = query !== null && !dismissed && options.length > 0

  // 查询词变了（继续打字 / 删字）就重新打开、回到第一项
  useEffect(() => {
    setDismissed(false)
    setActive(0)
  }, [query])

  /** 输入框元素（`ref` 正常时就是它；万一没透传，按 `name="message"` 兜一次） */
  const textareaOf = (): HTMLTextAreaElement | null =>
    textareaRef.current ?? document.querySelector<HTMLTextAreaElement>('textarea[name="message"]')

  const updateAnchor = useCallback((): void => {
    const box = textareaOf()?.getBoundingClientRect()
    if (!box) return
    setAnchor({
      left: box.left,
      width: box.width,
      bottom: window.innerHeight - box.top + 8,
    })
  }, [])

  // 菜单跟随输入框移动：窗口缩放、页面滚动（捕获阶段，任何滚动容器都算）都重新量一次
  useEffect(() => {
    if (!open) return
    updateAnchor()
    window.addEventListener('resize', updateAnchor)
    window.addEventListener('scroll', updateAnchor, true)
    return () => {
      window.removeEventListener('resize', updateAnchor)
      window.removeEventListener('scroll', updateAnchor, true)
    }
  }, [open, updateAnchor])

  // 键盘上下移动时把当前项滚进可视区（菜单限高 16rem）
  useEffect(() => {
    if (!open) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  /** 焦点还给输入框，光标落到末尾（插入 / 删标签后继续打字的地方） */
  const focusTextarea = (): void => {
    const element = textareaOf()
    if (!element) return
    element.focus()
    element.setSelectionRange(element.value.length, element.value.length)
  }

  const choose = (key: string): void => {
    controller.textInput.setInput(insertSkillToken(controller.textInput.value, key))
    setDismissed(true)
    requestAnimationFrame(focusTextarea)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!open) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (index + 1) % options.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (index - 1 + options.length) % options.length)
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      // 输入法组字中的回车是"选字确认"，不是选技能
      if (event.nativeEvent.isComposing) return
      const skill = options[active]
      if (!skill) return
      event.preventDefault()
      choose(skill.skillKey)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setDismissed(true)
    }
  }

  return (
    <>
      <PromptInputTextarea
        ref={textareaRef}
        placeholder={placeholder}
        submitOn={submitOn}
        pasteTextAsAttachment={pasteTextAsAttachment}
        onKeyDown={handleKeyDown}
      />
      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              style={{ left: anchor.left, width: anchor.width, bottom: anchor.bottom }}
              className="fixed z-[60] overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
            >
              <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground">
                技能
              </div>
              <div
                ref={listRef}
                role="listbox"
                aria-label="选择技能"
                className="max-h-64 overflow-y-auto p-1"
              >
                {options.map((skill, index) => (
                  <button
                    key={skill.skillKey}
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-index={index}
                    onMouseEnter={() => setActive(index)}
                    // mousedown 而不是 click：click 之前 textarea 会先失焦，插入后光标就没了
                    onMouseDown={(event) => {
                      event.preventDefault()
                      choose(skill.skillKey)
                    }}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left',
                      index === active ? 'bg-muted' : 'hover:bg-muted/60',
                    )}
                  >
                    <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="shrink-0 font-mono text-xs">{skill.skillKey}</span>
                    <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                      {skill.description}
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
                ↑↓ 选择 · Enter 插入 · Esc 关闭
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
