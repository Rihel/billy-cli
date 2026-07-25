'use client'

import { Form, Modal } from 'antd'
import type { FormInstance, FormProps, ModalProps } from 'antd'
import { useState } from 'react'
import type { ReactNode } from 'react'

export type ModalFormProps<Values extends object> = {
  open: boolean
  title: ReactNode
  form: FormInstance<Values>
  children: ReactNode
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
  loading,
  resetOnClose = true,
  formProps,
  modalProps,
  onSubmit,
  onCancel,
  onError,
}: ModalFormProps<Values>) => {
  const [submitting, setSubmitting] = useState(false)

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
          setSubmitting(true)
          try {
            await onSubmit(values)
          } catch (error) {
            onError?.(error)
          } finally {
            setSubmitting(false)
          }
        }}
      >
        {children}
      </Form>
    </Modal>
  )
}
