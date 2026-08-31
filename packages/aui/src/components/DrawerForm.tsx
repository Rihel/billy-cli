'use client'

import { Button, Drawer, Form, Space } from 'antd'
import type { DrawerProps, FormInstance, FormProps } from 'antd'
import { useBoolean } from 'ahooks'
import type { ReactNode } from 'react'
import { FormFields } from './form/FormRenderer'
import type { FormFieldSchema } from './form/FormRenderer'

export type DrawerFormProps<Values extends object> = {
  open: boolean
  title: ReactNode
  form: FormInstance<Values>
  children?: ReactNode
  items?: Array<FormFieldSchema<Values> | FormFieldSchema<Values>[]>
  /** 表单上方的说明区（如配置指引 / 提示文案） */
  description?: ReactNode
  /** Drawer 宽度（默认 480） */
  width?: number
  loading?: boolean
  resetOnClose?: boolean
  /** 提交按钮文案（默认「提交」） */
  submitText?: string
  formProps?: Omit<FormProps<Values>, 'form' | 'onFinish' | 'children'>
  drawerProps?: Omit<
    DrawerProps,
    'open' | 'title' | 'onClose' | 'children' | 'footer'
  >
  onSubmit: (values: Values) => void | Promise<void>
  onCancel: () => void
  onError?: (error: unknown) => void
}

/**
 * 侧滑抽屉表单（声明式 items，与 ModalForm 同构，适合字段较多 / 需说明文案的表单）。
 * 用法见 develop-frontend-page skill 的 ModalForm 章节（items / render / onSubmit 一致）。
 */
export const DrawerForm = <Values extends object>({
  open,
  title,
  form,
  children,
  items,
  description,
  width = 480,
  loading,
  resetOnClose = true,
  submitText = '提交',
  formProps,
  drawerProps,
  onSubmit,
  onCancel,
  onError,
}: DrawerFormProps<Values>) => {
  const [submitting, { setTrue: startSubmitting, setFalse: stopSubmitting }] =
    useBoolean()

  return (
    <Drawer
      {...drawerProps}
      title={title}
      open={open}
      width={width}
      onClose={onCancel}
      afterOpenChange={(visible) => {
        if (!visible && resetOnClose) form.resetFields()
        drawerProps?.afterOpenChange?.(visible)
      }}
      destroyOnHidden={drawerProps?.destroyOnHidden ?? true}
      footer={
        <div style={{ textAlign: 'right' }}>
          <Space>
            <Button onClick={onCancel}>取消</Button>
            <Button
              type="primary"
              loading={loading || submitting}
              onClick={() => form.submit()}
            >
              {submitText}
            </Button>
          </Space>
        </div>
      }
    >
      {description}
      <Form<Values>
        {...formProps}
        form={form}
        layout={formProps?.layout ?? 'vertical'}
        onFinish={async (values) => {
          startSubmitting()
          try {
            await onSubmit(values)
          } catch (error) {
            onError?.(error)
          } finally {
            stopSubmitting()
          }
        }}
      >
        {items ? <FormFields form={form} items={items} /> : children}
      </Form>
    </Drawer>
  )
}
