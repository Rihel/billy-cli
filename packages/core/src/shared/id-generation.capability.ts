import { nanoid } from '@repo/shared'
import { Context, Effect, Layer } from 'effect'

export interface IdGenerationApi {
  next(length?: number): string
}

export class IdGeneration extends Context.Tag('IdGeneration')<
  IdGeneration,
  IdGenerationApi
>() {}

export const IdGenerationLive = Layer.effect(
  IdGeneration,
  Effect.sync(() => {
    return {
      next: (length = 20) => {
        return nanoid(length)
      },
    }
  }),
)
