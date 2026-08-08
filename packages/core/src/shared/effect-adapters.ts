import { Effect } from 'effect'

export const trySync = <A, E>(
  operation: () => A,
  onError: (cause: unknown) => E,
) =>
  Effect.try({
    try: operation,
    catch: onError,
  })

export const tryPromise = <A, E>(
  operation: () => PromiseLike<A>,
  onError: (cause: unknown) => E,
) =>
  Effect.tryPromise({
    try: operation,
    catch: onError,
  })

export const makePromiseAdapter =
  <E>(onError: (cause: unknown) => E) =>
  <A>(operation: () => PromiseLike<A>) =>
    tryPromise(operation, onError)
