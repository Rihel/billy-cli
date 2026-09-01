"use client"

import type { ReactNode } from "react"
import type { ReactFormExtendedApi } from "@tanstack/react-form"
import { useStore } from "@tanstack/react-store"

import { cn } from "#lib/utils"
import { Checkbox } from "#components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "#components/ui/field"
import { Input } from "#components/ui/input"
import { Label } from "#components/ui/label"
import {
  RadioGroup,
  RadioGroupItem,
} from "#components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#components/ui/select"
import { Switch } from "#components/ui/switch"
import { Textarea } from "#components/ui/textarea"

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
  | "input"
  | "password"
  | "textarea"
  | "number"
  | "select"
  | "radio"
  | "checkbox"
  | "switch"
  | "date"

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
  /** 根据当前表单值决定是否隐藏该字段 */
  hidden?: (values: Values) => boolean
  /** 静态禁用，或根据当前表单值动态禁用 */
  disabled?: boolean | ((values: Values) => boolean)
  /** 透传给底层控件的 props（如 options / placeholder / autoComplete / multiple） */
  props?: Record<string, unknown>
  /** 必填：true 使用默认文案「该项为必填项」，或传入自定义错误文案 */
  required?: boolean | string
  /** 自定义校验：返回错误文案（undefined 表示通过） */
  validate?: (
    value: unknown,
    values: Values,
  ) => string | undefined | Promise<string | undefined>
  /** 字段默认值 */
  defaultValue?: unknown
  /** 自定义渲染（优先于 widget） */
  render?: (context: FormFieldContext<Values>) => ReactNode
}

export type FormFieldsProps<Values extends object> = {
  form: AnyFormApi<Values>
  items: Array<FormFieldSchema<Values> | FormFieldSchema<Values>[]>
}

const isEmptyValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim() === ""
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
): ReactNode => {
  const props = item.props ?? {}
  const value = field.state.value

  switch (item.widget) {
    case "password":
      return (
        <Input
          type="password"
          value={(value as string) ?? ""}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case "textarea":
      return (
        <Textarea
          value={(value as string) ?? ""}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case "number":
      return (
        <Input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          disabled={disabled}
          onChange={(event) =>
            field.handleChange(
              event.target.value === "" ? undefined : Number(event.target.value),
            )
          }
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case "date":
      return (
        <Input
          type="date"
          value={(value as string) ?? ""}
          disabled={disabled}
          onChange={(event) => field.handleChange(event.target.value)}
          onBlur={field.handleBlur}
          {...props}
        />
      )
    case "select": {
      const options = (props.options as SelectOption[] | undefined) ?? []
      const multiple =
        props.multiple === true || (props.mode as string) === "multiple"
      return (
        <Select
          multiple={multiple}
          value={
            multiple
              ? ((value as unknown[]) ?? [])
              : ((value as string | number) ?? null)
          }
          onValueChange={(next) => field.handleChange(next)}
          disabled={disabled}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={(props.placeholder as string) ?? "请选择"} />
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
    case "radio": {
      const options = (props.options as SelectOption[] | undefined) ?? []
      return (
        <RadioGroup
          value={(value as string) ?? null}
          onValueChange={(next) => field.handleChange(next)}
          disabled={disabled}
        >
          {options.map((option) => (
            <div key={String(option.value)} className="flex items-center gap-2">
              <RadioGroupItem
                id={`radio-${String(option.value)}`}
                value={String(option.value)}
              />
              <Label htmlFor={`radio-${String(option.value)}`}>
                {option.label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )
    }
    case "checkbox":
      return (
        <div className="flex items-center gap-2">
          <Checkbox
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(checked) => field.handleChange(checked === true)}
            {...props}
          />
          {(props.children as ReactNode) ?? item.label ? (
            <Label>
              {((props.children as ReactNode) ?? item.label) as ReactNode}
            </Label>
          ) : null}
        </div>
      )
    case "switch":
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
          value={(value as string) ?? ""}
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
  const disabled =
    typeof item.disabled === "function" ? item.disabled(values) : item.disabled

  return (
    <form.Field
      name={item.name as any}
      defaultValue={item.defaultValue as any}
      validators={{
        onSubmit: ({ value }: { value: unknown }) => {
          if (item.required && isEmptyValue(value)) {
            return typeof item.required === "string"
              ? item.required
              : "该项为必填项"
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
            className="min-w-0 flex-1"
          >
            {item.label && item.widget !== "checkbox" ? (
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
                  )}
              {item.hint ? (
                <FieldDescription>{item.hint}</FieldDescription>
              ) : null}
              <FieldError errors={errors} />
            </FieldContent>
          </Field>
        )
      }}
    </form.Field>
  )
}

/** 声明式表单项渲染（@tanstack/react-form）：items 为字段行，数组内为同行多列 */
export function FormFields<Values extends object>({
  form,
  items,
}: FormFieldsProps<Values>) {
  return (
    <>
      {items.map((entry, index) => {
        const row = Array.isArray(entry) ? entry : [entry]
        return (
          <div key={index} className="flex flex-wrap gap-4">
            {row.map((item, itemIndex) => (
              <FormField
                key={`${String(item.name)}-${itemIndex}`}
                form={form}
                item={item}
              />
            ))}
          </div>
        )
      })}
    </>
  )
}

export type FormRendererProps<Values extends object> = {
  form: AnyFormApi<Values>
  items: Array<FormFieldSchema<Values> | FormFieldSchema<Values>[]>
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
      className={cn("flex flex-col gap-4", className)}
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
