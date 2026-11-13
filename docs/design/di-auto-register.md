# @repo/di 自动注册（autoRegister）落地方案

> 已废弃（2026-09-12）：`@repo/di` 与 `autoRegister` 已随 NestJS 12 重构删除；现状见 `.agents/skills/billy-dev-foundation`。
>
> 2026-11-13 复核（标注仍然准确）：`packages/` 现在只有 `http-client` / `kits` / `sdk` / `shared` / `ui`
> 五个包，**没有 `packages/di`**；全仓库不再有 `@repo/di` 依赖，也没有
> `AppContext` / `LifeCycleHost` / `autoRegister` / `markManual` / `createServiceContext` /
> `service-context.ts` 的任何实现或引用。DI 现由 `@nestjs/common` 承担
> （`@Injectable` / `@Inject` / `@Optional`），装配是**显式模块**（`providers` / `exports` /
> `imports`）；「漏登记只在运行时才报错」这个本文要解决的问题，现在由
> 「每个构造器参数都显式 `@Inject(token)`」的硬约束 + `pnpm check:inject` 静态检查兜底
> （见 `nestjs-migration.md` §2.3 / §3.5）。
>
> 以下正文是当时的方案设计记录，保留历史论证与取舍（其中 `@repo/kits/src/service-context.ts`、
> `AppContext.markManual`、`main.ts` 里逐个 `addService` 的写法等均已不存在）。

> 状态：待实现 · 日期：2026-09-06 · 影响包：`@repo/di`（核心）、`@repo/kits`（service-context）、`apps/server`（main.ts）

## 1. 目标与问题

现状痛点：新增一个业务 service/repository 需要**两处手动登记**：

1. 业务类写 `@Injectable()` + 构造器 `@Inject(...)`（定义处）；
2. `apps/server/src/main.ts` 手动 `import` 该类并 `.addService(X)` / `.addLifeCycleService(X)`（组合根处）。

漏登记只在运行时（依赖解析）报错，无编译期兜底，且随着模块增多 main.ts 膨胀。

**目标**：`@Injectable()` 装饰的类自动成为容器 bean；实现了生命周期钩子
（`OnAppStart` / `OnAppStop`）的类自动被识别为生命周期组件——组合根不再需要逐个
`addService` / `addLifeCycleService`。

## 2. 核心约束（调查结论）

### 2.1 装饰器只在 import 时执行（JS 语言硬约束）

「自动识别」的前提是类被 import 过（装饰器执行时才登记）。幸运的是组合根
`apps/server/src/main.ts` **已经 import 了全部业务类**（为了 addService 引用），
因此登记表在 `ensureBeansAppended`（惰性首次 get/start）执行前必然完整——
ESM import 静态提升保证。改造后这些 import 保留即可（甚至可收敛为模块级副作用入口）。

### 2.2 kits 基建是「按配置分片条件装配」+ `@Optional` —— 不能无差别全量注册

调查发现 `packages/kits/src/service-context.ts` 全部基建类都带 `@Injectable()`，
但装配是**有条件的**：

- `if (config.db) ctx.addLifeCycleService(Db)` —— 配置缺失则不注册该组件；
- `Notifier` 用 `@Optional()` 注入 `FileClient / LarkNotifyClient / EmailClient`，
  未配置的通道不注册 → 注入 `undefined`（运行时优雅降级）。

**若 autoRegister 把注册表里所有 `@Injectable` 类全量绑定，条件装配语义被破坏**：
没配 lark 也绑 LarkClient（构造需要 LarkConfig → 报错）；@Optional 变成永远有值。
因此 kits 基建层**保持显式 addService / addLifeCycleService**，通过
`AppContext.markManual(...)` 声明「这些类由组合根手动管理，autoRegister 跳过」。

### 2.3 分层边界：自动注册只服务业务层

- 业务模块（`apps/server/src/modules/*`）：11 个 repository/service **100% 带 @Injectable**，
  无条件装配、无 @Optional —— 适合自动注册；
- kits 基建（16 个 @Injectable 类）：条件装配 + @Optional —— 显式注册（现状不变）；
- `createServiceContext` 内部仍逐类 addService / addLifeCycleService（一处配置分片集中点，改动小）。

## 3. 方案设计

### 3.1 `@repo/di` 改动（核心）

**di.ts：装饰器自登记全局注册表**

```ts
// 全局注册表：记录所有被执行过 @Injectable() 的类（模块 import 时登记）
const injectableRegistry = new Set<Ctor>()
export function Injectable(): ClassDecorator {
  return (target) => {
    injectableRegistry.add(target as Ctor)   // 自登记
    originInjectable()(target)
  }
}
// 供 AppContext 读取（内部使用，不导出可变引用）
export const getInjectableRegistry = () => injectableRegistry
```

**life-cycle.ts：新增「是否生命周期组件」判别**

```ts
/** 类原型上是否声明了生命周期钩子方法（onAppStart / onAppStop 至少其一） */
export const hasLifeCycleHooks = (target: any): boolean =>
  typeof target?.prototype?.onAppStart === 'function' ||
  typeof target?.prototype?.onAppStop === 'function'
```

**app-context.ts：markManual + autoRegister**

```ts
export class AppContext {
  private readonly manualTokens = new Set<any>()   // 组合根手动管理、auto 跳过

  /** 声明这些类由组合根显式管理（addService/addLifeCycleService 手动装配），autoRegister 跳过 */
  markManual(...tokens: any[]): this {
    tokens.forEach((t) => this.manualTokens.add(t))
    return this
  }

  /** 自动装配：注册表里未手动管理、未显式 add 的类 → 绑定单例；带生命周期钩子的自动进 LifeCycleHost */
  autoRegister(): this {
    for (const token of getInjectableRegistry()) {
      if (this.manualTokens.has(token)) continue
      if (this.services.has(token) || this.transientServices.has(token)) continue
      if (hasLifeCycleHooks(token)) this.addLifeCycleService(token)
      else this.addService(token)
    }
    return this
  }
}
```

### 3.2 `@repo/kits` 改动（service-context.ts）

在 `createServiceContext` 装配末尾、`return ctx` 前追加：

```ts
// 基建按配置分片显式装配（条件装配 + @Optional 语义依赖此边界），不参与业务层自动注册
ctx.markManual(
  Db, RedisStore, QueueManager, StreamHub, SessionStore, ObjectStorage,
  TokenSigner, PasswordHasher, RateLimiter, Scheduler, IdGeneration, Telemetry,
  LarkClient, LarkNotifyClient, Notifier, FileClient, EmailClient,
)
return ctx
```

### 3.3 `apps/server` 改动（main.ts）

- 业务类 import 收敛为**模块级副作用入口**：新建 `apps/server/src/modules/index.ts`，
  `export * from './xxx/index.js'` 聚合（同时触发各模块类装饰器登记）；
- main.ts 改为 `import './modules/index.js'`（副作用，触发登记），删除 12 行逐个
  `addService`，在 `createServiceContext(...)` 链上追加 `.autoRegister()`；
- `ServerConfig / MonitorConfig` 两个应用级配置仍走 `addConstant`（不变）。

```ts
export const runtime: AppContext = createServiceContext({...})
  .addConstant(ServerConfig, serverConfig)
  .addConstant(MonitorConfig, monitorConfig)
  .autoRegister()   // ← 业务类全部自动装配（替代下方 12 行 addService）
```

## 4. 关键流程（数据流）

1. 模块被 import（`main.ts → ./modules/index.js`）→ 各业务类 `@Injectable()` 装饰器执行
   → 登记进全局注册表；
2. `createServiceContext(...)` 装配 kits 基建（显式、条件）→ `.markManual(...)` 标记基建；
3. `.autoRegister()` 遍历注册表：跳过 manual 基建 → 业务 repository/service 全部
   `addService`（无生命周期钩子）或 `addLifeCycleService`（有钩子，未来业务生命周期组件自动识别）；
4. `await runtime.start()` → LifeCycleHost 照常按拓扑序启动。

## 5. 边界与注意

- **业务类若实现 `OnAppStart/OnAppStop`（未来有连接型业务组件）**：autoRegister 自动识别为
  生命周期组件（走 `addLifeCycleService`），拓扑排序逻辑不变——无需手动登记；
- **测试**：`@repo/di/test/app-context.test.ts` 补用例——装饰器自登记、
  markManual 跳过、生命周期钩子自动识别、autoRegister 与显式 addService 不冲突（去重）；
- **显式 addService 仍保留**：`createServiceContext`（基建）与脚本（seed 等）需要按需装配的
  场景不受影响——autoRegister 只补「没被显式管理过的」类；
- 依赖方向不变：`di` 不依赖 kits/server；kits 依赖 di（现状）。
