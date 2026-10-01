'use client'

import { Button, Input, Switch } from '@repo/ui'
import { RotateCcwIcon } from 'lucide-react'

/**
 * 工具专属配置面板（**一期按工具手写**）。
 *
 * 为什么手写而不是"照 JSON Schema 自动生成表单"：配置项的语义差别很大
 * （`run-command` 的时长是"默认值 + 硬上限"、`run-sub-agent` 的 0 是"沿用部署默认"、
 * 规划那四个工具（`plan-*`）干脆没有可配项），自动表单只能生成控件、生成不了这些口径，
 * 而配错一个上限的代价是模型当场调不动工具。故一期由页面把口径写在字段旁边，
 * 未来新增的工具走底部的兜底面板（按 `defaultConfig` 的键与类型渲染）。
 */

/** 控件类型：布尔 / 数字 / 文本 / JSON 文本（复杂结构的兜底） */
type ConfigFieldKind = 'switch' | 'number' | 'text' | 'json'

type ConfigFieldSpec = {
  key: string
  label: string
  kind: ConfigFieldKind
  hint?: string
}

export type ToolConfigPanelProps = {
  toolKey: string
  /** 当前生效配置（库里的值 + 代码默认值补齐） */
  config: Record<string, unknown>
  /** 代码默认值（`spec.config.parse({})`） */
  defaults: Record<string, unknown>
  /** 改一个配置项 */
  onChange: (key: string, value: unknown) => void
}

/** `run-command`：命令执行能力的配置（时长与输出上限都会在服务端再夹一次） */
const RUN_COMMAND_FIELDS: ConfigFieldSpec[] = [
  {
    key: 'enabled',
    label: '命令执行能力开关',
    kind: 'switch',
    hint: '与治理层的「启用」是两层闸门：两层都开才放行',
  },
  {
    key: 'timeoutMs',
    label: '单条命令默认时长（毫秒）',
    kind: 'number',
    hint: '模型可以要求更短；要求更长会被夹到这个值',
  },
  {
    key: 'maxOutputBytes',
    label: '单条流输出上限（字节）',
    kind: 'number',
    hint: 'stdout / stderr 各自的上限，超出即截断并终止命令',
  },
  {
    key: 'workDir',
    label: '工作根目录',
    kind: 'text',
    hint: '留空 = 服务进程的工作目录；agent 传入的 cwd 只能落在这个目录之内',
  },
]

/** `run-sub-agent`：子 agent 能力的四个旋钮（0 = 沿用部署默认） */
const RUN_SUB_AGENT_FIELDS: ConfigFieldSpec[] = [
  {
    key: 'maxPerRun',
    label: '同一轮子 agent 个数上限',
    kind: 'number',
    hint: '0 = 沿用部署默认',
  },
  {
    key: 'maxDepth',
    label: '子 agent 深度上限',
    kind: 'number',
    hint: '0 = 沿用部署默认',
  },
  {
    key: 'maxSteps',
    label: '单个子 agent 步数上限',
    kind: 'number',
    hint: '0 = 沿用部署默认',
  },
  {
    key: 'timeoutMs',
    label: '单个子 agent 时长上限（毫秒）',
    kind: 'number',
    hint: '0 = 沿用部署默认',
  },
]

/** 按默认值类型猜控件（兜底面板用） */
const kindOf = (value: unknown): ConfigFieldKind => {
  if (typeof value === 'boolean') return 'switch'
  if (typeof value === 'number') return 'number'
  if (value !== null && typeof value === 'object') return 'json'
  return 'text'
}

/** 兜底面板：按 `Object.keys(defaultConfig)` 渲染（将来新增的工具不必改本文件就能配） */
const fallbackFields = (defaults: Record<string, unknown>): ConfigFieldSpec[] =>
  Object.keys(defaults).map((key) => ({
    key,
    label: key,
    kind: kindOf(defaults[key]),
    hint: '兜底面板：按代码默认值的类型渲染；复杂结构请填 JSON',
  }))

/** 该工具用哪一组字段（规划那四个工具没有可配项，返回空数组） */
const fieldsOf = (toolKey: string, defaults: Record<string, unknown>): ConfigFieldSpec[] => {
  if (toolKey === 'run-command') return RUN_COMMAND_FIELDS
  if (toolKey === 'run-sub-agent') return RUN_SUB_AGENT_FIELDS
  if (toolKey.startsWith('plan-')) return []
  return fallbackFields(defaults)
}

/** 默认值展示文案（空串与 null 都是"空"） */
const formatDefault = (value: unknown): string => {
  if (value === undefined || value === null || value === '') return '空'
  if (typeof value === 'boolean') return value ? '开' : '关'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** 单个配置项：控件 + 默认值说明 + 「用默认值」 */
const ConfigFieldRow = ({
  spec,
  config,
  defaults,
  onChange,
}: {
  spec: ConfigFieldSpec
  config: Record<string, unknown>
  defaults: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
}) => {
  const value = config[spec.key]
  const control = (() => {
    switch (spec.kind) {
      case 'switch':
        return (
          <Switch
            checked={value === true}
            aria-label={spec.label}
            onCheckedChange={(next) => onChange(spec.key, next === true)}
          />
        )
      case 'number':
        return (
          <Input
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            placeholder="留空 = 用默认值"
            onChange={(event) =>
              onChange(
                spec.key,
                event.target.value === '' ? undefined : Number(event.target.value),
              )
            }
          />
        )
      case 'json':
        return (
          <Input
            className="font-mono text-xs"
            value={typeof value === 'string' ? value : JSON.stringify(value)}
            onChange={(event) => onChange(spec.key, event.target.value)}
          />
        )
      default:
        return (
          <Input
            value={typeof value === 'string' ? value : value == null ? '' : String(value)}
            onChange={(event) => onChange(spec.key, event.target.value)}
          />
        )
    }
  })()

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{spec.label}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange(spec.key, defaults[spec.key])}
        >
          <RotateCcwIcon />
          用默认值
        </Button>
      </div>
      {control}
      <span className="text-xs text-muted-foreground">
        {spec.hint ? `${spec.hint}；` : ''}
        默认值：{formatDefault(defaults[spec.key])}
      </span>
    </div>
  )
}

/** 工具专属配置面板（没有可配项时只给一句话） */
export function ToolConfigPanel({
  toolKey,
  config,
  defaults,
  onChange,
}: ToolConfigPanelProps) {
  const fields = fieldsOf(toolKey, defaults)
  if (fields.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        这个工具没有可配项（开关、作用域与限额在上面的治理区里改）。
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {fields.map((spec) => (
        <ConfigFieldRow
          key={spec.key}
          spec={spec}
          config={config}
          defaults={defaults}
          onChange={onChange}
        />
      ))}
    </div>
  )
}
