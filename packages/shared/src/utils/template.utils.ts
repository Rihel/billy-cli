import _ from 'lodash'
import { hasContentArray } from './is.utils'

export type TemplateEngine = ReturnType<typeof createTemplateEngine>
export type TemplateEngineOptions = Parameters<typeof createTemplateEngine>['0']
export function createTemplateEngine(options?: {
  start: string
  end: string
  keepEnd?: boolean
}) {
  const start = options?.start || '{{'
  const end = options?.end || '}}'
  const escapeRegExp = (str: string) =>
    str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regStartStr = escapeRegExp(start)
  const regEndStr = end === '\b' ? '\\b' : escapeRegExp(end)
  const matchRegexpStr = `${regStartStr}(.*?)${regEndStr}`
  const matchRegexp = new RegExp(matchRegexpStr, 'g')
  const singleRegexp = new RegExp(matchRegexpStr)
  const getReplace = (key: string, flags?: string) => {
    return new RegExp(`${regStartStr}( *${key} *)${regEndStr}`, flags)
  }

  const resolveVariables = (source: string) => {
    const matches = source.match(matchRegexp)
    if (matches) {
      const res = matches.filter(Boolean).reduce(
        (acc, item) => {
          const variableKey = singleRegexp.exec(item)
          if (variableKey) {
            acc.push({
              name: variableKey[1]!.trim(),
            })
          }
          return acc
        },
        [] as { name: string }[],
      )
      return res
    }
    return []
  }

  /**
   * 检查模板是否包含变量
   * 不传name参数，检查模板中是否有变量
   * 如果传了name参数，
   * - 如果是字符串，则检查模板中是否包含该变量
   * - 如果是数组，则检查模板中是否都包含这些变量
   *
   * @param {string} source 模板
   * @param {(string | string[])} [name] 变量名或变量名数组
   * @return {boolean}
   */
  const hasVariable = (source: string, name?: string | string[]) => {
    const variables = resolveVariables(source)
    if (hasContentArray(variables)) {
      if (Array.isArray(name)) {
        return name.every((item) => {
          return variables.some((variable) => variable.name === item)
        })
      }
      if (typeof name === 'string') {
        return variables.some((variable) => variable.name === name)
      }
      return true
    }
    return false
  }

  const render = (source: string, data?: Record<string, any>) => {
    const variableDefinitions = resolveVariables(source)
    let res = source

    variableDefinitions.forEach((item) => {
      const key = item.name
      const value = _.get(data, key, '')
      const regexp = getReplace(key)

      res = res.replace(regexp, options?.keepEnd ? value + end : value)
    })
    return res
  }

  return {
    strings: {
      end: regEndStr,
      start: regStartStr,
      match: matchRegexpStr,
    },
    regexps: {
      match: matchRegexp,
      singleMatch: singleRegexp,
    },
    hasVariable,
    getReplace,
    resolveVariables,
    render,
  }
}

export function resolveTemplateMetadata(options?: {
  start: string
  end: string
}) {
  const start = options?.start || '{{'
  const end = options?.end || '}}'
  const escapeRegExp = (str: string) =>
    str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regStartStr = escapeRegExp(start)
  const regEndStr = escapeRegExp(end)
  const regStr = `${regStartStr}([^${regStartStr}${regEndStr}]+)${regEndStr}`
  return {
    start: regStartStr,
    end: regEndStr,
    match: regStr,
    getReplace: (key: string) => {
      return new RegExp(`${regStartStr}( *${key} *)${regEndStr}`)
    },
  }
}

export function parseTemplateVariables(
  source = '',
  options?: { start: string; end: string },
) {
  const { match } = resolveTemplateMetadata(options)
  const matches = source.match(new RegExp(match, 'g'))
  if (matches) {
    return matches.filter(Boolean).reduce(
      (acc, item) => {
        const variableKey = new RegExp(match).exec(item)
        if (variableKey) {
          acc.push({
            name: variableKey[1]!.trim(),
          })
        }
        return acc
      },
      [] as { name: string }[],
    )
  }
  return []
}

export function renderTemplate(
  source: string,
  data?: Record<string, any>,
  options?: { start: string; end: string },
) {
  const meta = resolveTemplateMetadata(options)
  const variableDefinitions = parseTemplateVariables(source, options)
  let res = source

  variableDefinitions.forEach((item) => {
    const key = item.name
    const value = _.get(data, key, '')
    const regexp = meta.getReplace(key)
    res = res.replace(regexp, value)
  })
  return res
}
