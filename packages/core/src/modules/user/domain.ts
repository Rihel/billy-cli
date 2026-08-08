import { Data } from 'effect'

export class User extends Data.Class<{
  id: string
  email: string
  realName: string | null
  avatar: string | null
  createdAt: Date
  updatedAt: Date
}> {}

export class CreateUser extends Data.Class<{
  email: string
  password: string
  realName?: string | null
  avatar?: string | null
}> {}

export class UpdateUser extends Data.Class<{
  userId: string
  realName?: string | null
  avatar?: string | null
}> {}

export class UserPageQuery extends Data.Class<{
  page: number
  size: number
  keyword?: string
  orderBy?: 'createdAt' | 'updatedAt' | 'email'
  order?: 'asc' | 'desc'
}> {}

export class UserId extends Data.Class<{ userId: string }> {}

export class RemoveUser extends Data.Class<{ userId: string }> {}

export class ResetUserPassword extends Data.Class<{
  userId: string
  password: string
}> {}

export class UserSuccessResult extends Data.Class<{ success: true }> {}
