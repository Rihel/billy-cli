export type ActionSuccess<TData> = {
  ok: true
  data: TData
}

export type ActionFailure = {
  ok: false
  error: string
}

export type ActionResponse<TData> = ActionSuccess<TData> | ActionFailure

export type Action<TInput, TData> = (
  input: TInput,
) => Promise<ActionResponse<TData>>

export type ActionHandler<TInput, TData> = (input: TInput) => Promise<TData>

export type DefineActionOptions = {
  fallbackError: string
  getError?: (error: unknown) => string
  onError?: (error: unknown) => void | Promise<void>
}

export type CallActionOptions<TData> = {
  onSuccess?: (data: TData) => void | Promise<void>
  onError?: (error: string) => void | Promise<void>
}

function getErrorMessage(error: unknown, fallbackError: string) {
  return error instanceof Error && error.message ? error.message : fallbackError
}

export function defineAction<TInput, TData>(
  handler: ActionHandler<TInput, TData>,
  options: DefineActionOptions,
): Action<TInput, TData> {
  return async (input) => {
    try {
      return { ok: true, data: await handler(input) }
    } catch (error) {
      await options.onError?.(error)
      return {
        ok: false,
        error:
          options.getError?.(error) ??
          getErrorMessage(error, options.fallbackError),
      }
    }
  }
}

export async function callAction<TInput, TData>(
  action: Action<TInput, TData>,
  input: TInput,
  options: CallActionOptions<TData> = {},
) {
  const response = await action(input)

  if (response.ok === true) {
    await options.onSuccess?.(response.data)
  } else {
    await options.onError?.(response.error)
  }

  return response
}
