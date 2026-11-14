# @repo/monitor

监控引擎：指标采集 / 规则评估 / 告警生命周期 / 通知，只依赖 `@repo/kits` / `@repo/shared` / `@repo/db`。

- main（9989）与 agent-runtime（9990）各装配一份 `MonitorModule.forRootAsync(...)`，各自监控自己的进程；
- HTTP API（告警 / 规则 / 指标查询与配置）留在 `apps/main/src/modules/monitor/api`，本包不含控制器；
- 业务模块通过 `MonitorRegistry` 注册指标 / 规则定义。
