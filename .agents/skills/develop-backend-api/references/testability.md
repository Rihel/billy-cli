# 可测试性（develop-backend-api 引用文件）

> 本文件是 `develop-backend-api` skill 的组成部分，由主 SKILL.md 引用。
> 设计接口代码时同步考虑「怎么测」；写测试的具体套路见 `write-tests` skill。

考虑什么：写接口时同步设计「这个逻辑怎么单测」，别交付后才补测试。
仓库落地：
- 分层即测试边界：路由薄（只做校验与转发）、业务在 service（构造器 `@Inject` 注入依赖，
  测试时传 mock 实现即可，不必真连 DB / Redis）、数据访问在 repository。
- 规则抽纯函数：状态机转移表、计价 / 校验等计算放 `shared/utils` 纯函数直接单测
  （`state-machine` skill 已要求「转移表为纯函数，可单测」）。
- 错误走契约可断言：业务抛 `AppError` 断 `{ code }`；HTTP 层 `ApiError` 断 `{ code, status }`
  （测试套路见 `write-tests` skill，参考 `packages/http-client/test/` 现有测试）。
- 副作用经门面：日志 `AppLogger`、队列、存储、通知都经构造器注入的门面，测试里替换为 stub，
  不在 service 里散落裸的全局调用。

检查项：service 核心分支（成功 / 查无 / 无权限 / 非法输入）在单测里跑过，不依赖真实外部服务。
