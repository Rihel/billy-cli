import { Eta } from 'eta'
import { fileURLToPath } from 'node:url'

/**
 * eta 模板引擎实例：模板文件统一放在 ./files/ 下（.eta 后缀），
 * 通过 renderFile 按「类型/文件名」渲染，变量经 `<%= it.xxx %>` 注入。
 */
const eta = new Eta({
  views: fileURLToPath(new URL('./files/', import.meta.url)),
  autoEscape: false,
  // 关闭自动 trim：标签后的换行原样保留，多行片段（列定义 / 搜索条件等）才不会被粘连
  autoTrim: false,
})

/** 渲染 templates/files/ 下的模板文件（模板内用 `<%= it.xxx %>` 访问数据） */
export function renderFile(
  template: string,
  data: Record<string, unknown>,
): string {
  return eta.render(`./${template}`, data)
}

/** 将对象序列化为 JSON 字符串（package.json / tsconfig 等用对象序列化更稳） */
export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
