export interface AppResponse<T> {
  code: number
  message?: string
  data?: T
}

export interface AppPaginateResponse<T> {
  items: T[]
  total: number
  page: number
  size: number
}

export interface AppCursorPaginateResponse<T, TCursor> {
  items: T[]
  nextCursor: TCursor | null
}

export const ResponseUtils = {
  isSuccess<T>(response: AppResponse<T>): boolean {
    return response.code === 0
  },

  isError<T>(response: AppResponse<T>): boolean {
    return response.code !== 0
  },
  success<T>(data: T, message?: string): AppResponse<T> {
    return {
      code: 0,
      message,
      data,
    }
  },

  error<T>(code: number = -1, message?: string, data?: T): AppResponse<T> {
    return {
      code,
      message,
      data,
    }
  },
}
