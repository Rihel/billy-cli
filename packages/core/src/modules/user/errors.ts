import { Data } from 'effect'

export class UserNotFoundError extends Data.TaggedError('UserNotFoundError')<{
  userId?: string
}> {}

export class EmailTakenError extends Data.TaggedError('EmailTakenError')<{
  email: string
}> {}
