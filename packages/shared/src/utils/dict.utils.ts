import _ from 'lodash'

import { listToMapWith } from './complex.utils'

type OptionConfig<Data extends Record<string, any>> = {
  labelKey: keyof Data
  valueKey: keyof Data
}
type MakeOption<
  Data extends Record<string, any>,
  Config extends OptionConfig<Data>,
> = {
  label: Data[Config['labelKey']]
  value: Data[Config['valueKey']]
  i18n?: Record<string, any>
} & Data

export type Dict = ReturnType<typeof createDict>

export function createDict<
  T extends Record<string, any>,
  DataSource extends Record<string, T>,
>(
  dataSource: DataSource,
  optionConfig: OptionConfig<T> = { labelKey: 'label', valueKey: 'value' },
) {
  type Option = MakeOption<T, OptionConfig<T>>
  type Result = {
    _source: DataSource
    _config: OptionConfig<T>

    options: Option[]
    values: Option['value'][]
    labels: Option['label'][]
    filterOptions(
      filterFn: (option: Option, index: number) => boolean,
      language?: string,
    ): Option[]
    getOption(value: Option['value']): Option | undefined
    getOptions(language?: string): Option[]
    getField(
      value: Option['value'],
      field: keyof Option,
    ): Option[keyof Option] | undefined
    getLabel(value: Option['value'], language?: string): string | undefined
    pickOptions: (values: Option['value'][], language?: string) => Option[]
    omitOptions: (values: Option['value'][], language?: string) => Option[]
  } & {
    [Key in keyof DataSource]: Option['value']
  } & {
    [Key in keyof DataSource as `is${Capitalize<Key & string>}`]: (
      data: Option['value'],
    ) => boolean
  }

  const res: any = {
    _source: dataSource,
    _config: optionConfig,
    options: [],
    labels: [],
    values: [],
  }

  for (const key in dataSource) {
    if (Object.prototype.hasOwnProperty.call(dataSource, key)) {
      const item = dataSource[key]
      const label = item[optionConfig.labelKey]
      const value = item[optionConfig.valueKey]
      const option = { label, value, ...item }
      res.options.push(option)
      res.labels.push(label)
      res.values.push(value)
      res[key] = value
      res[_.camelCase(`is_${key}`)] = (v: Option['value']) => {
        return value === v
      }
    }
  }

  function getOptions(language?: string) {
    if (!language) return res.options
    return res.options.map((item: any) => {
      return {
        ...item,
        label: getLabel(item.value, language),
      }
    })
  }

  function filterOptions(
    filterFn: (option: Option, index: number) => boolean,
    language?: string,
  ) {
    return getOptions(language).filter(filterFn)
  }

  function omitOptions(values: Option['value'][], language?: string) {
    return getOptions(language).filter((item: Option) => {
      return !values.includes(item['value'])
    })
  }

  function pickOptions(values: Option['value'][], language?: string) {
    return getOptions(language).filter((item: Option) => {
      return values.includes(item['value'])
    })
  }

  function getOption(value: Option['value']) {
    return res.options.find((item: Option) => {
      return item.value === value
    })
  }

  function getField(value: Option['value'], field: keyof Option) {
    const option = getOption(value)
    return option?.[field]
  }

  function getLabel(value: Option['value'], language?: string) {
    const option = getOption(value)
    if (!language) return option?.label
    const i18n: Record<string, any> = option?.i18n
    if (!i18n || !(language in i18n)) {
      return option?.label
    }
    return i18n[language]
  }
  const result = {
    getField,
    getLabel,
    getOption,
    filterOptions,
    pickOptions,
    omitOptions,
    getOptions,
    ...res,
  } as unknown as Result
  return result
}

/**
 * 基于基础数据类型数组创建一个选项列表
 * @param {Array<string | number>} arr 数组
 * @returns
 */
export function createOptionByArray(arr: Array<string | number> = []) {
  return arr.map((item) => {
    return {
      label: item,
      value: item,
    }
  })
}

export function withAllOption<T extends Dict>(
  dict: T,
  i18n?: Record<string, any>,
) {
  const dataSource = {
    All: {
      label: '全部',
      value: 'all',
      [dict._config.labelKey]: '全部',
      [dict._config.valueKey]: 'all',
      i18n,
    },
    ...dict._source,
  }
  const res = createDict(dataSource, dict._config)

  return res as unknown as typeof res & T
}

export type CreateDictByDataSourceOptions<T> = {
  labelKey: keyof T | ((v: T) => string)
  valueKey: keyof T
  all?: boolean
  allI18n?: Record<string, any>
}

export function createDictByDataSource<T extends Record<string, any>>(
  dataSource: T[],
  options?: CreateDictByDataSourceOptions<T>,
) {
  const { valueKey = 'id' } = options || {}
  const internalDataSource = _.cloneDeep(dataSource).map((item) => {
    let label
    if (typeof options?.labelKey === 'string') {
      label = item[options?.labelKey]
    } else if (typeof options?.labelKey === 'function') {
      label = options?.labelKey(item)
    } else {
      throw new Error('labelKey is required')
    }
    return {
      ...item,
      label,
      value: item[valueKey],
    }
  })

  const map = listToMapWith(internalDataSource, 'value') as unknown as Record<
    string,
    T
  >

  //@ts-ignore
  const res = createDict(map)
  if (options?.all === true) {
    return withAllOption(res as Dict, options?.allI18n)
  }

  return res
}

export function createTrueFalseOption(
  trueOption = { label: '是', value: true },
  falseOption = { label: '否', value: false },
) {
  const dict = createDict({
    True: trueOption,
    False: falseOption,
  })
  const allDict = withAllOption(dict)

  return {
    dict,
    allDict,
  }
}
