'use client'

import type { ReactNode } from 'react'
import type { ReactFormExtendedApi } from '@tanstack/react-form'
import { useStore } from '@tanstack/react-store'

import { cn } from '#lib/utils'
import { Checkbox } from '#components/ui/checkbox'
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from '#components/ui/field'
import { Input } from '#components/ui/input'
import { Label } from '#components/ui/label'
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'
import { SegmentedControl } from '#components/ui/segmented-control'
import { Switch } from '#components/ui/switch'
import { Textarea } from '#components/ui/textarea'

/** @tanstack/react-form 的 useForm 返回实例（组件 props 用） */
export type AnyFormApi<Values extends object> = ReactFormExtendedApi<
  Values,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any,
  any
>

export type FormWidget =
  | 'input'
  | 'password'
  | 'textarea'
  | 'number'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'switch'
  | 'date'

export type SelectOption = {
  label: ReactNode
  value: string | number
}

export type FormFieldContext<Values extends object> = {
  /** 表单实例（可用于 setFieldValue 等） */
  form: AnyFormApi<Values>
  /** 当前字段 api（value / handleChange / handleBlur） */
  field: WidgetFieldApi
  values: Values
  disabled: boolean
}

export type FormFieldSchema<Values extends object = Record<string, unknown>> = {
  name: string
  label?: ReactNode
  widget?: FormWidget
  /** 字段说明文案（渲染在控件下方） */
  hint?: ReactNode
  /** 多列网格中该字段占几列（默认 1；宽控件如 textarea / 多选建议 2） */
  span?: 1 | 2
  /** 根据当前表单值决定是否隐藏该字段 */
  hidden?: (values: Values) => boolean
  /** 静态禁用，或根据当前表单值动态禁用 */
  disabled?: boolean | ((values: Values) => boolean)
  /** 透传给底层控件的 props（如 options / placeholder / autoComplete / multiple） */
  props?: Record<string, unknown>
  /** 必填：true 使用默认文案「该项为必填项」，或传入自定义错误文案 */
  required?: boolean | string
  /** 自定义校验：返回错误文案（undefined 表示通过） */
  validate?: (value: unknown, values: Values) => string | undefined | Promise<string | undefined>
  /** 字段默认值 */
  defaultValue?: unknown
  /** 自定义渲染（优先于 widget） */
  render?: (context: FormFieldContext<Values>) => ReactNode
}

/** 字段行：单字段或同排多字段（数组） */
export type FormFieldRow<Values extends object> =
  | FormFieldSchema<Values>
  | FormFieldSchema<Values>[]

/** 字段分组：标题 + 说明 + 组内字段（组内自动两列网格布局） */
export type FormFieldGroup<Values extends object> = {
  type?: 'group'
  /** 分组标题 */
  title?: ReactNode
  /** 分组说明（标题下方小字） */
  description?: ReactNode
  fields: Array<FormFieldRow<Values>>
}

export type FormItem<Values extends object> = FormFieldRow<Values> | FormFieldGroup<Values>

export type FormFieldsProps<Values extends object> = {
  form: AnyFormApi<Values>
  items: Array<FormItem<Values>>
}

const isEmptyValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.length === 0
  return false
}

type WidgetFieldApi = {
  state: {
    value: unknown
    meta: { errors: unknown[] }
  }
  handleChange: (value: unknown) => void
  handleBlur: () => void
}

const renderWidget = (
  field: WidgetFieldApi,
  item: FormFieldSchema<any>,
  disabled: boolean,
  valueFromStore: unknown,
): ReactNode => {
  const props = item.props ?? {}
  // 显示值以 form.store.values 为准（reset / 编辑回填后必然重渲染）；
  // field.state.value 在弹窗场景可能滞后于 reset。
  const value = valueFromStore === undefined ? field.state.value : valueFromStore

  switch (item.widget) {
    case 'password':
      return (
        <Input
          type="password"
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case 'textarea':
      return (
        <Textarea
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case 'number':
      return (
        <Input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          disabled={disabled}
          onChange={(event) =>
            field.handleChange(event.target.value === '' ? undefined : Number(event.target.value))
          }
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case 'date':
      return (
        <Input
          type="date"
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case 'select': {
      const options = (props.options as SelectOption[] | undefined) ?? []
      const multiple = props.multiple === true || (props.mode as string) === 'multiple'
      // 选项很少的枚举直接铺开成分段选择：一眼看全，少一次展开
      if (!multiple && options.length > 0 && options.length <= 4) {
        return (
          <SegmentedControl
            value={(value as string | null) ?? null}
            options={options.map((option) => ({
              label: option.label,
              value: String(option.value),
            }))}
            disabled={disabled}
            onValueChange={(next) => field.handleChange(next)}
          />
        )
      }
      const resolveLabel = (item: unknown): ReactNode => {
        const match = options.find((option) => String(option.value) === String(item))
        return match ? match.label : String(item)
      }
      return (
        <Select
          multiple={multiple}
          value={multiple ? ((value as unknown[]) ?? []) : ((value as string | number) ?? null)}
          onValueChange={(next) => field.handleChange(next)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            {/* 自定义 children 渲染 label：不依赖 base-ui items 注册（Popup 关闭时解析不到） */}
            <SelectValue placeholder={(props.placeholder as string) ?? '请选择'}>
              {(selected) => {
                if (
                  selected == null ||
                  selected === '' ||
                  (Array.isArray(selected) && selected.length === 0)
                ) {
                  return (props.placeholder as string) ?? '请选择'
                }
                const list = Array.isArray(selected) ? selected : [selected]
                return list.map(resolveLabel).join('、')
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={String(option.value)} value={String(option.value)}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    }
    case 'radio': {
      const options = (props.options as SelectOption[] | undefined) ?? []
      return (
        <RadioGroup
          value={(value as string) ?? null}
          onValueChange={(next) => field.handleChange(next)}
          disabled={disabled}
        >
          {options.map((option) => (
            <div key={String(option.value)} className="flex items-center gap-2">
              <RadioGroupItem id={`radio-${String(option.value)}`} value={String(option.value)} />
              <Label htmlFor={`radio-${String(option.value)}`}>{option.label}</Label>
            </div>
          ))}
        </RadioGroup>
      )
    }
    case 'checkbox':
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => field.handleChange(checked === true)}
            {...props}
          />
          {((props.children as ReactNode) ?? item.label) ? (
            <Label>{((props.children as ReactNode) ?? item.label) as ReactNode}</Label>
          ) : null}
        </div>
      )
    case 'switch':
      return (
        <Switch
          checked={value === true}
          disabled={disabled}
          onCheckedChange={(checked) => field.handleChange(checked === true)}
          {...props}
        />
      )
    default:
      return (
        <Input
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
  }
}

const FormField = <Values extends object>({
  form,
  item,
}: {
  form: AnyFormApi<Values>
  item: FormFieldSchema<Values>
}) => {
  const values = useStore(form.store, (state) => state.values)
  if (item.hidden?.(values)) return null
  const disabled = typeof item.disabled === 'function' ? item.disabled(values) : item.disabled

  return (
    <form.Field
      name={item.name as any}
      defaultValue={item.defaultValue as any}
      validators={{
        onSubmit: ({ value }: { value: unknown }) => {
          if (item.required && isEmptyValue(value)) {
            return typeof item.required === 'string' ? item.required : '该项为必填项'
          }
          return item.validate ? item.validate(value, values) : undefined
        },
      }}
    >
      {(field) => {
        const errors = (field.state.meta.errors ?? [])
          .filter((message: unknown): message is string => Boolean(message))
          .map((message) => ({ message }))
        return (
          <Field
            data-invalid={errors.length > 0 || undefined}
            className={cn('min-w-0 flex-1', item.span === 2 && 'sm:col-span-2')}
          >
            {item.label && item.widget !== 'checkbox' ? (
              <FieldLabel>{item.label}</FieldLabel>
            ) : null}
            <FieldContent>
              {item.render
                ? item.render({
                    form,
                    field: field as unknown as WidgetFieldApi,
                    values,
                    disabled: disabled ?? false,
                  })
                : renderWidget(
                    field as unknown as WidgetFieldApi,
                    item,
                    disabled ?? false,
                    (values as Record<string, unknown>)[item.name],
                  )}
              {item.hint ? <FieldDescription>{item.hint}</FieldDescription> : null}
              <FieldError errors={errors} />
            </FieldContent>
          </Field>
        )
      }}
    </form.Field>
  )
}

const isGroup = <Values extends object>(entry: FormItem<Values>): entry is FormFieldGroup<Values> =>
  typeof entry === 'object' &&
  entry !== null &&
  'fields' in entry &&
  Array.isArray((entry as FormFieldGroup<Values>).fields)

/** 单字段（顶层未分组时的一行容器） */
const FieldRowWrap = <Values extends object>({
  row,
  index,
  form,
}: {
  row: FormFieldRow<Values>
  index: number
  form: AnyFormApi<Values>
}) => {
  if (Array.isArray(row)) {
    // 同排多字段：flex 均分（原行为）
    return (
      <div key={index} className="flex flex-wrap gap-4">
        {row.map((item, itemIndex) => (
          <FormField key={`${String(item.name)}-${itemIndex}`} form={form} item={item} />
        ))}
      </div>
    )
  }
  return <FormField key={index} form={form} item={row as FormFieldSchema<Values>} />
}

/**
 * 声明式表单项渲染（@tanstack/react-form）。
 * - 顶层元素：字段 / 字段数组（同排多列）/ 分组（FormFieldGroup）。
 * - 分组内自动 `grid sm:grid-cols-2`：单字段占一列（span=2 占整行），
 *   字段数组占整行做内部均分（保持「同排」语义）。
 */
export function FormFields<Values extends object>({ form, items }: FormFieldsProps<Values>) {
  return (
    <>
      {items.map((entry, index) => {
        if (isGroup(entry)) {
          const rows = entry.fields
          return (
            <div key={index} className="space-y-3">
              {entry.title ? (
                <div className="flex flex-col gap-0.5">
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {entry.title}
                  </div>
                  {entry.description ? (
                    <div className="text-xs text-muted-foreground/80">{entry.description}</div>
                  ) : null}
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2">
                {rows.map((row, rowIndex) => {
                  if (Array.isArray(row)) {
                    return (
                      <div key={rowIndex} className="flex flex-wrap gap-4 sm:col-span-2">
                        {row.map((item, itemIndex) => (
                          <FormField
                            key={`${String(item.name)}-${itemIndex}`}
                            form={form}
                            item={item}
                          />
                        ))}
                      </div>
                    )
                  }
                  return (
                    <FormField key={rowIndex} form={form} item={row as FormFieldSchema<Values>} />
                  )
                })}
              </div>
            </div>
          )
        }
        return (
          <FieldRowWrap key={index} row={entry as FormFieldRow<Values>} index={index} form={form} />
        )
      })}
    </>
  )
}

export type FormRendererProps<Values extends object> = {
  form: AnyFormApi<Values>
  items: Array<FormItem<Values>>
  children?: ReactNode
  className?: string
}

/** 表单渲染器：<form> + 声明式 items + 自定义 children（如提交按钮） */
export function FormRenderer<Values extends object>({
  form,
  items,
  children,
  className,
}: FormRendererProps<Values>) {
  return (
    <form
      className={cn('flex flex-col gap-5', className)}
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FormFields form={form} items={items} />
      {children}
    </form>
  )
}
