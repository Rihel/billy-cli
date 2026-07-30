'use client'

import { Form, Modal } from 'antd'
import type { FormInstance, FormProps, ModalProps } from 'antd'
import { useBoolean } from 'ahooks'
import type { ReactNode } from 'react'
import { FormFields } from './form/FormRenderer'
import type { FormFieldSchema } from './form/FormRenderer'

export type ModalFormProps<Values extends object> = {
  open: boolean
  title: ReactNode
  form: FormInstance<Values>
  children?: ReactNode
  items?: Array<FormFieldSchema<Values> | FormFieldSchema<Values>[]>
  loading?: boolean
  resetOnClose?: boolean
  formProps?: Omit<FormProps<Values>, 'form' | 'onFinish' | 'children'>
  modalProps?: Omit<
    ModalProps,
    'open' | 'title' | 'onOk' | 'onCancel' | 'children' | 'confirmLoading'
  >
  onSubmit: (values: Values) => void | Promise<void>
  onCancel: () => void
  onError?: (error: unknown) => void
}

export const ModalForm = <Values extends object>({
  open,
  title,
  form,
  children,
  items,
  loading,
  resetOnClose = true,
  formProps,
  modalProps,
  onSubmit,
  onCancel,
  onError,
}: ModalFormProps<Values>) => {
  const [submitting, { setTrue: startSubmitting, setFalse: stopSubmitting }] =
    useBoolean()

  return (
    <Modal
      {...modalProps}
      title={title}
      open={open}
      confirmLoading={loading || submitting}
      onOk={() => form.submit()}
      onCancel={onCancel}
      afterClose={() => {
        if (resetOnClose) form.resetFields()
        modalProps?.afterClose?.()
      }}
      destroyOnHidden={modalProps?.destroyOnHidden ?? true}
    >
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
    </Modal>
  )
}
