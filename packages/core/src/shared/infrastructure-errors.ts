import { Data } from 'effect'

export class PasswordHashingError extends Data.TaggedError(
  'PasswordHashingError',
)<{
  cause: unknown
}> {}

export class TokenSigningError extends Data.TaggedError('TokenSigningError')<{
  cause: unknown
}> {}

export class RedisStoreError extends Data.TaggedError('RedisStoreError')<{
  cause: unknown
}> {}

export class ObjectStorageError extends Data.TaggedError('ObjectStorageError')<{
  operation: string
  cause: unknown
}> {}
