import type { AgentFileModel, AgentFileNode } from '../schema/agent.schema'
import _ from 'lodash'
import { hasContentArray } from './is.utils'

type RecursionTreeOptions<T extends Record<string, any>> = {
  childrenKey?: keyof T
  visit?: (item: T, parent: T | null, index: number, path: T[], depth?: number) => void
  stop?: (item: T) => boolean
}
export function recursionTree<T extends Record<string, any>>(
  data: T[],
  options: RecursionTreeOptions<T>,
) {
  const json = Array.isArray(data) ? data : [data]
  const { childrenKey, visit, stop } = Object.assign(
    {
      childrenKey: 'children',
      stop: () => false,
      visit: () => {},
    },
    options,
  )

  const walk = (list: T[], parent: T | null, path: T[] = [], depth: number = 0) => {
    for (let i = 0; i < list.length; i++) {
      const item = list[i]
      const newPath = [...path, item]
      const isStop = stop(item)

      if (isStop) {
        visit(item, parent, i, newPath, depth)
        break
      } else {
        visit(item, parent, i, newPath, depth)
      }
      const children = item[childrenKey]
      if (children && children.length > 0) {
        walk(children, item, newPath, depth + 1)
      }
    }
  }
  walk(json, null)
}

export function treeToArray<T extends Record<string, any>>(treeData: T[]) {
  const res: T[] = []
  recursionTree(treeData, {
    visit(item) {
      res.push(item)
    },
  })
  return res
}

type ArrayToTreeOptions<T extends Record<PropertyKey, any>, CK extends PropertyKey> = {
  parentKey: keyof T
  readonly childrenKey: CK
  primaryKey: keyof T
  sort?: {
    key: keyof T
    order: 'asc' | 'desc'
  }
}
type TreeResult<T extends Record<PropertyKey, any>, CK extends PropertyKey> = T & {
  [K in CK]?: TreeResult<T, CK>[]
}

export const arrayToTree = <T extends Record<PropertyKey, any>, CK extends PropertyKey>(
  list: T[] = [],
  options?: ArrayToTreeOptions<T, CK>,
): TreeResult<T, CK>[] => {
  type Item = TreeResult<T, CK>

  const { parentKey, childrenKey, primaryKey } = _.merge(
    {
      parentKey: 'parentId',
      childrenKey: 'children',
      primaryKey: 'id',
    },
    options,
  )

  const sortedList = options?.sort
    ? _.orderBy(list, [options?.sort.key], [options?.sort.order])
    : list
  const res: Record<string, Item[] | Item> = {
    root: [],
  }

  // 做一个map的初始化
  const listWithChildren = sortedList.map((item) => {
    // 添加子元素的数组
    const newItem = { ...item, [childrenKey]: [] } as Item
    // 获取到主键
    const mapKey = newItem[primaryKey]
    res[mapKey] = newItem
    return newItem
  })

  // 将子元素添加到父元素
  listWithChildren.forEach((item) => {
    const parentId = item[parentKey]
    if (parentId && res[parentId]) {
      const parent = res[parentId] as Item
      const children = [...parent[childrenKey], item]
      //@ts-ignore
      parent[childrenKey] = children
    } else {
      res.root = [
        // @ts-ignore
        ...res.root,
        item,
      ]
    }
  })

  const tree = _.cloneDeep(res.root) as Item[]
  recursionTree(tree, {
    visit: (item) => {
      if (_.isEmpty(item.children)) {
        delete item.children
      }
    },
  })

  return tree
}

type ITreeNode<T extends Record<string, any>, CK extends keyof T | PropertyKey> = T & {
  [K in CK]?: ITreeNode<T, CK>[]
}

type TreeUtilCallback<T extends Record<string, any>, CK extends keyof T, Res extends any> = (
  item: ITreeNode<T, CK>,
  index: number,
  parent?: ITreeNode<T, CK> | null,
) => Res

export const findTree = <T extends Record<string, any>, CK extends keyof T>(
  tree: ITreeNode<T, CK>[],
  fn: TreeUtilCallback<T, CK, boolean>,
  options?: { childrenKey: CK },
) => {
  const { childrenKey } = _.merge({ childrenKey: 'children' }, options)
  const res: ITreeNode<T, CK>[] = []
  recursionTree(tree, {
    childrenKey,
    visit: (item, parent, index, _path) => {
      const match = fn(item, index, parent)
      if (match) {
        res.push(item)
      }
    },
  })
  return res
}

export const filterTree = <T extends Record<string, any>, CK extends keyof T>(
  tree: ITreeNode<T, CK>[],
  fn: TreeUtilCallback<T, CK, boolean>,
  options?: { childrenKey?: CK; keepWithTrue?: boolean },
) => {
  const { childrenKey } = _.merge({ childrenKey: 'children', keepWithTrue: true }, options)

  const walk = (list: ITreeNode<T, CK>[], parent?: ITreeNode<T, CK> | null): ITreeNode<T, CK>[] => {
    return list.filter((item, index) => {
      const res = fn(item, index, parent)
      if (res) {
        if (hasContentArray(item[childrenKey])) {
          _.set(item, childrenKey, walk(item[childrenKey], item))
        }
      }

      return res
    })
  }
  return walk(tree, null)
}

export const mapTree = <
  Res extends Record<string, any>,
  T extends Record<string, any>,
  CK extends keyof T,
>(
  tree: ITreeNode<T, CK>[],
  fn: TreeUtilCallback<T, CK, Res>,
  options?: { childrenKey: CK },
) => {
  type NewTreeNode = ITreeNode<Res, CK | keyof Res>
  const { childrenKey } = _.merge({ childrenKey: 'children' }, options)

  const walk = (list: ITreeNode<T, CK>[]): Res[] => {
    return list.map((item, index) => {
      const newItem = { ...item } as unknown as NewTreeNode
      if (hasContentArray(newItem[childrenKey])) {
        // @ts-ignore
        newItem[childrenKey] = walk(newItem[childrenKey])
      }
      return fn(item, index, newItem as T)
    })
  }
  return walk(tree)
}

export const treeToMap = <T extends Record<string, any>, CK extends keyof T, PK extends keyof T>(
  tree: ITreeNode<T, CK>[],
  options?: { childrenKey: CK; primaryKey: PK },
) => {
  const { childrenKey, primaryKey } = _.merge(
    { childrenKey: 'children', primaryKey: 'id' },
    options || {},
  )
  const map: Record<string, ITreeNode<T, CK>> = {}

  recursionTree(tree, {
    childrenKey,
    visit: (item) => {
      const mapKey = item[primaryKey]
      map[mapKey] = item
    },
  })
  return map
}

/**
 * 文件清单 → 文件树（目录隐式生成）。
 *
 * 输入是 `ai_files` 的扁平行；`path` 用 `/` 分层。文件节点的 `name` 用 `filename`
 * （入站是原始文件名，不是 md5 路径），目录节点用路径段。排序：目录在前、同类按名字升序。
 */
export const buildFileTree = <T extends { path: string; filename: string }>(
  entries: readonly T[],
): AgentFileNode[] => {
  const root: AgentFileNode[] = []
  const dirs = new Map<string, AgentFileNode>()

  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    let list = root
    let acc = ''
    for (let index = 0; index < segments.length - 1; index += 1) {
      acc = acc ? `${acc}/${segments[index]}` : segments[index]
      let dir = dirs.get(acc)
      if (!dir) {
        dir = { name: segments[index], path: acc, type: 'dir', children: [] }
        dirs.set(acc, dir)
        list.push(dir)
      }
      list = dir.children!
    }
    list.push({
      name: entry.filename || segments[segments.length - 1],
      path: entry.path,
      type: 'file',
      file: entry as unknown as AgentFileModel,
    })
  }

  const sort = (nodes: AgentFileNode[]): void => {
    nodes.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'dir' ? -1 : 1
      return left.name.localeCompare(right.name, 'zh-Hans-CN')
    })
    for (const node of nodes) if (node.children) sort(node.children)
  }
  sort(root)
  return root
}
