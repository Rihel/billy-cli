/**
 * 业务模块副作用入口：import 各业务模块 → 触发 @Injectable 装饰器执行登记，
 * 供 main.ts 的 runtime.autoRegister() 自动装配。
 *
 * 新增业务模块后在此追加一行副作用 import（模块自身仍保持 index.ts 聚合导出）。
 */
import './admin/index.js'
import './auth/index.js'
import './monitor/index.js'
import './todo/index.js'
import './user/index.js'
