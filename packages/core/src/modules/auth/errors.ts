import { Data } from 'effect'

export class EmailNotFoundError extends Data.TaggedError('EmailNotFoundError')<{
  email: string
}> {}

export class InvalidCredentialsError extends Data.TaggedError(
  'InvalidCredentialsError',
) {}

export class InvalidResetTokenError extends Data.TaggedError(
  'InvalidResetTokenError',
) {}

export class ExpiredResetTokenError extends Data.TaggedError(
  'ExpiredResetTokenError',
) {}

export class InvalidOldPasswordError extends Data.TaggedError(
  'InvalidOldPasswordError',
) {}

export class PasswordUnchangedError extends Data.TaggedError(
  'PasswordUnchangedError',
) {}

export class InvalidTokenError extends Data.TaggedError('InvalidTokenError') {}
