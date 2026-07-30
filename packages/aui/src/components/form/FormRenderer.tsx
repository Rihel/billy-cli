'use client'

import { maybeFun } from '@repo/shared'
import type { MaybeFunction } from '@repo/shared'
import {
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Radio,
  Select,
  Switch,
} from 'antd'
import type { FormInstance, FormItemProps, FormProps } from 'antd'
import { cloneElement } from 'react'
import type { CSSProperties, ReactElement, ReactNode } from 'react'

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
  | 'date-range'

export type FormFieldContext<Values extends object> = {
  form: FormInstance<Values>
  values: Values
  disabled: boolean
}

export type FormFieldSchema<Values extends object = Record<string, unknown>> = {
  name: FormItemProps<Values>['name']
  label?: ReactNode
  widget?: FormWidget
  hidden?: MaybeFunction<boolean, [Values]>
  disabled?: MaybeFunction<boolean, [Values]>
  props?: MaybeFunction<Record<string, unknown>, [FormFieldContext<Values>]>
  formItemProps?: Omit<FormItemProps<Values>, 'name' | 'label' | 'children'>
  render?: (context: FormFieldContext<Values>) => ReactNode
}

export type FormRendererProps<Values extends object> = {
  form: FormInstance<Values>
  items: Array<FormFieldSchema<Values> | FormFieldSchema<Values>[]>
  children?: ReactNode
  formProps?: Omit<FormProps<Values>, 'form' | 'children'>
  columnGap?: number
  className?: string
  style?: CSSProperties
}

export type FormFieldsProps<Values extends object> = Pick<
  FormRendererProps<Values>,
  'form' | 'items' | 'columnGap'
>

const widgets: Record<FormWidget, ReactElement<Record<string, unknown>>> = {
  input: <Input />,
  password: <Input.Password />,
  textarea: <Input.TextArea />,
  number: <InputNumber className="w-full" />,
  select: <Select />,
  radio: <Radio.Group />,
  checkbox: <Checkbox />,
  switch: <Switch />,
  date: <DatePicker className="w-full" />,
  'date-range': <DatePicker.RangePicker className="w-full" />,
}

const FormField = <Values extends object>({
  item,
  form,
}: {
  item: FormFieldSchema<Values>
  form: FormInstance<Values>
}) => {
  const values = (Form.useWatch([], form) ?? {}) as Values
  const hidden = maybeFun(item.hidden, values)
  if (hidden) return null

  const disabled = maybeFun(item.disabled, values) ?? false
  const context = { form, values, disabled }
  const fieldProps = maybeFun(item.props, context)
  const widget = item.widget ?? 'input'
  const valuePropName =
    item.formItemProps?.valuePropName ??
    (widget === 'checkbox' || widget === 'switch' ? 'checked' : undefined)

  return (
    <Form.Item<Values>
      {...item.formItemProps}
      name={item.name}
      label={item.label}
      valuePropName={valuePropName}
      className="min-w-0 flex-1"
    >
      {item.render
        ? item.render(context)
        : cloneElement(widgets[widget], { ...fieldProps, disabled })}
    </Form.Item>
  )
}

export const FormFields = <Values extends object>({
  form,
  items,
  columnGap = 16,
}: FormFieldsProps<Values>) => (
  <>
    {items.map((entry, index) => {
      const row = Array.isArray(entry) ? entry : [entry]
      return (
        <div key={index} className="flex flex-wrap" style={{ gap: columnGap }}>
          {row.map((item, itemIndex) => (
            <FormField
              key={`${String(item.name)}-${itemIndex}`}
              item={item}
              form={form}
            />
          ))}
        </div>
      )
    })}
  </>
)

export const FormRenderer = <Values extends object>({
  form,
  items,
  children,
  formProps,
  columnGap,
  className,
  style,
}: FormRendererProps<Values>) => (
  <Form<Values>
    {...formProps}
    form={form}
    className={className}
    style={style}
    layout={formProps?.layout ?? 'vertical'}
  >
    <FormFields form={form} items={items} columnGap={columnGap} />
    {children}
  </Form>
)
