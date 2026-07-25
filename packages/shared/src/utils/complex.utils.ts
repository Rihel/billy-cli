import { isAvailableData, isComplexData } from "./is.utils";

import _ from "lodash";
import { getDataType } from "./base.utils";

export function pickAvailableData<T extends Record<string, any | null | undefined>>(data: T) {
  return _.pickBy(data, (value) => isAvailableData(value))
}




/**
 * 转换数组，通过fieldsMap 配置，提取元素的字段，映射成新的字段  
 * @param {Array<Record<string,any>>} array 
 * @param {Array<[OldFieldName, newFieldName]>} fieldsMap 
 * @returns 
 */
export function pickDataByArray<
  T extends Record<string, any>,
  K extends keyof T,
  MappedKeys extends string,
  FieldMap extends [K, MappedKeys]
>(array: T[], fieldsMap: FieldMap[]) {
  return array.map((item) => {
    const newItem: Record<MappedKeys, any> = {} as Record<MappedKeys, any>
    fieldsMap.forEach((fieldMap) => {
      if (Array.isArray(fieldMap)) {
        const [oldField, newField] = fieldMap
        newItem[newField] = item[oldField]
      }
    })
    return newItem
  })
}

export function listToMapWith<T extends Record<string, any>>(list: T[], key: keyof T): { [key: string]: T };
export function listToMapWith<T extends Record<string, any>>(list: T[], key: keyof T, valueKey: keyof T): { [key: string]: T[keyof T] };
export function listToMapWith<T extends Record<string, any>, F extends (data: T) => any>(list: T[], key: keyof T, valueKey: F): { [key: string]: ReturnType<F> };
export function listToMapWith(list: any = [], key: any, valueKey?: any) {
  return list.reduce((acc: any, item: { [x: string]: any }) => {
    const keyName = item[key]
    let value = item
    if (isAvailableData(valueKey)) {
      if (_.isString(valueKey)) {
        value = item[valueKey]
      } else if (_.isFunction(valueKey)) {
        value = valueKey?.(item)
      }
    }
    return {
      ...acc,
      [keyName]: value,
    }
  }, {})
}



type CbParams = {
  key: string,
  value: any
  dataType: string,
  dataPath: string[],
  parent: any
  depth: number
}
/**
 * 递归遍历复杂数据
 * @param json 
 * @param fn 
 * @returns 
 */
export function eachComplexData<T extends Record<string, any>, Cb extends (data: CbParams) => void>(json: T, fn: Cb) {
  const walk = (data: T, { deep, path }: { deep: number, path?: string[] }) => {
    for (const key in data) {
      const dataPath = path ? [...path, key] : [key]
      if (Object.hasOwnProperty.call(data, key)) {
        const element = data[key]
        if (_.isArray(element) || _.isObject(element)) {
          fn?.({
            key,
            value: element,
            dataType: getDataType(element) as string,
            dataPath,
            parent: data,
            depth: deep
          })
          walk(element, {
            deep: deep + 1,
            path: dataPath,
          })
        } else {
          fn?.({
            key,
            value: element,
            dataType: getDataType(element) as string,
            dataPath,
            parent: data,
            depth: deep
          })
        }
      }
    }
  }
  if (!isComplexData(json)) return
  walk(json, { deep: 1 })
}
