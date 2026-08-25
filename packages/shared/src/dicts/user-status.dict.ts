import { createDict } from '../utils'

export const UserStatus = createDict({
  Enabled: { label: '启用', value: 'enabled' },
  Disabled: { label: '禁用', value: 'disabled' },
})
