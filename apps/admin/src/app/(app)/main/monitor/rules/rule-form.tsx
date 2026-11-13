'use client'

import { useEffect, useState } from 'react'
import type {
  MonitorRuleConfigField,
  MonitorRuleDefinitionModel,
  MonitorRuleModel,
  UpdateMonitorRuleDto,
} from '@repo/shared'
import {
  Button,
  Checkbox,
  ConfirmAction,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DictSelect,
  Input,
  SegmentedControl,
  Switch,
  Tag,
  Label,
} from '@repo/ui'

type RuleFormModalProps = {
  open: boolean
  rule: MonitorRuleModel | null
  definition: MonitorRuleDefinitionModel | undefined
  saving: boolean
  onSave: (input: UpdateMonitorRuleDto) => Promise<void>
  onReset: (ruleKey: string) => Promise<void>
  onClose: () => void
}

/** 规则编辑：只改配置和开关，规则本身由代码定义 */
export function RuleFormModal({
  open,
  rule,
  definition,
  saving,
  onSave,
  onReset,
  onClose,
}: RuleFormModalProps) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [enabled, setEnabled] = useState(true)

  useEffect(() => {
    if (!rule || !open) return
    const { enabled: _enabled, ...config } = rule.config
    setValues(config)
    setEnabled(rule.enabled)
  }, [rule, open])

  const setValue = (key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }))
  }

  const submit = async () => {
    if (!rule) return
    await onSave({ ruleKey: rule.ruleKey, config: values, enabled })
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{rule?.name ?? '编辑规则'}</DialogTitle>
          <DialogDescription>
            规则逻辑由代码定义；这里只改阈值、级别、通道、静默期和开关。
          </DialogDescription>
        </DialogHeader>

        {rule && definition ? (
          <div className="flex flex-col gap-4">
            <dl className="grid grid-cols-2 gap-3 rounded-lg bg-surface-1 p-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">规则 key</dt>
                <dd className="mt-1 font-mono text-xs">{rule.ruleKey}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">指标</dt>
                <dd className="mt-1 font-mono text-xs">{rule.metricKey ?? '事件规则'}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">评估周期 / 窗口</dt>
                <dd className="mt-1">
                  {rule.evaluationIntervalSeconds}s / {rule.windowSeconds}s
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">启用</dt>
                <dd className="mt-1">
                  <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用规则" />
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">恢复通知</dt>
                <dd className="mt-1">
                  <Switch
                    checked={values.notifyOnRecovery === true}
                    onCheckedChange={(checked) => setValue('notifyOnRecovery', checked)}
                    aria-label="恢复时通知"
                  />
                </dd>
              </div>
            </dl>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {definition.fields.map((field) => (
                <FieldControl
                  key={field.key}
                  field={field}
                  value={values[field.key]}
                  onChange={(value) => setValue(field.key, value)}
                />
              ))}
            </div>

            <div className="flex items-center justify-between rounded-lg bg-surface-1 px-3 py-3">
              <Tag color="cyan">{definition.category === 'system' ? '系统规则' : '业务规则'}</Tag>
              <ConfirmAction
                title="恢复默认配置"
                description="只恢复阈值、级别、通道等配置，不改变当前启用状态。"
                onConfirm={() => onReset(rule.ruleKey)}
              >
                恢复默认
              </ConfirmAction>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={saving || !rule}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: MonitorRuleConfigField
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (field.type === 'multi-select') {
    const selected = Array.isArray(value) ? value.map(String) : []
    return (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <span className="text-sm font-medium">{field.label}</span>
        <div className="flex flex-wrap gap-4">
          {(field.options ?? []).map((option) => {
            const optionValue = String(option.value)
            const checked = selected.includes(optionValue)
            return (
              <Label key={optionValue} className="gap-2 text-sm font-normal">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(
                      next === true
                        ? [...selected, optionValue]
                        : selected.filter((item) => item !== optionValue),
                    )
                  }
                />
                {option.label}
              </Label>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <Label className="flex-col items-stretch gap-2">
      <span className="text-sm font-medium">{field.label}</span>
      {field.type === 'number' ? (
        <Input
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={typeof value === 'number' ? value : Number(value ?? 0)}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      ) : field.type === 'select' ? (
        // 选项少的枚举直接铺开（级别只有 3 个），多选仍走下位选择
        (field.options ?? []).length <= 4 ? (
          <SegmentedControl
            options={(field.options ?? []).map((option) => ({
              label: option.label,
              value: String(option.value),
            }))}
            value={String(value ?? '')}
            onValueChange={(next) => {
              const option = field.options?.find((item) => String(item.value) === next)
              onChange(option?.value ?? next)
            }}
          />
        ) : (
          <DictSelect
            options={(field.options ?? []).map((option) => ({
              label: option.label,
              value: String(option.value),
            }))}
            value={String(value ?? '')}
            onValueChange={(next) => {
              const option = field.options?.find((item) => String(item.value) === next)
              onChange(option?.value ?? next)
            }}
          />
        )
      ) : field.type === 'switch' ? (
        <Switch checked={value === true} onCheckedChange={onChange} />
      ) : (
        <Input value={String(value ?? '')} onChange={(event) => onChange(event.target.value)} />
      )}
      {field.description ? (
        <span className="text-xs text-muted-foreground">{field.description}</span>
      ) : null}
    </Label>
  )
}
