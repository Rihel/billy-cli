import _ from 'lodash'
import { createTemplateEngine } from './template.utils'
import { recursionTree } from './tree.utils'

export const urlTemplateEngine = createTemplateEngine({
  start: ':',
  end: '/',
  keepEnd: true,
})

export function genActualUrl(template: string, data: Record<string, any> = {}) {
  return urlTemplateEngine.render(template, data)
}

type LikeMenu = {
  url?: string
  children?: LikeMenu[]
  [key: string]: any
}

export function menusBuilder(menus: LikeMenu[] = []) {
  return (data: Record<string, any>) => {
    const res = _.cloneDeep(menus)
    recursionTree(res, {
      visit: (item) => {
        if (item.url) {
          item.url = genActualUrl(item.url, data)
        }
      },
    })
    return res
  }
}
export function resolveMenus(menus: LikeMenu[] = [], data: Record<string, any> = {}) {
  return menusBuilder(menus)(data)
}
