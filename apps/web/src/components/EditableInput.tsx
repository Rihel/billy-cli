'use client'

import { CloseOutlined, EditOutlined, SaveOutlined } from '@ant-design/icons'
import { Button, Input } from 'antd'
import { ReactNode } from 'react'
import { useImmer } from 'use-immer'

export type EditableInputProps = Partial<{
  children: ReactNode
  value: string
  onChange: (value: string) => void
}>

const EditableInput = ({ children, value, onChange }: EditableInputProps) => {
  const [editable, setEditable] = useImmer(false)
  const [innerValue, setInnerValue] = useImmer('')
  const handleEdit = () => {
    setEditable(true)
    setInnerValue(value!)
  }
  const handleSave = () => {
    setEditable(false)
    onChange?.(innerValue!)
    setInnerValue('')
  }
  const handleCancel = () => {
    setEditable(false)
    setInnerValue('')
  }
  return (
    <div className="flex  items-center gap-2">
      {editable ? (
        <Input
          value={innerValue}
          onChange={(e) => {
            const newValue = e.target.value
            setInnerValue(newValue)
          }}
          onPressEnter={() => {
            handleSave()
          }}
        />
      ) : (
        children
      )}
      <div className="flex gap-1 items-center">
        {editable ? (
          <>
            <Button
              icon={<SaveOutlined />}
              onClick={handleSave}
              type="link"
            ></Button>
            <Button
              icon={<CloseOutlined />}
              onClick={handleCancel}
              type="link"
              danger
            ></Button>
          </>
        ) : (
          <Button
            icon={<EditOutlined />}
            onClick={handleEdit}
            type="link"
          ></Button>
        )}
      </div>
    </div>
  )
}

export default EditableInput
