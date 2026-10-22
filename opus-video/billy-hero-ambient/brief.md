# brief：Billy Cli 首屏背景片（Signal Fabric）

<role>
你是这支 60 秒循环背景片的唯一制作者：用代码逐帧画出画面，用代码合成音乐，最后混成 MP4，并接进 `apps/web` 的 hero。
</role>

<inputs>
- 产品：Billy Cli —— AI 原生全栈模板（NestJS 12 + Next.js 16 双前端、pnpm monorepo、17 个 Agent Skills、监控引擎、SSE、AI agent）
- 已确认的素材事实：apps/web、apps/admin、apps/server、packages/ui、packages/sdk、packages/shared、packages/kits、http-client、PostgreSQL、Redis、17 skills、pnpm bootstrap
- 品牌取值（取自 `packages/ui/src/globals.css`）：背景 `#f0f2f7`、正文 `#0d0f15`、品牌靛紫 `#6057e7`、次级文字 `#5f636c`
- 字体（取自 `apps/web/.next/static/media` 的真实 woff2）：Space Grotesk、Geist、Geist Mono
- 放置位置：`apps/web/src/components/landing/hero.tsx` 的首屏背景（文字压在上面）
</inputs>

<direction>
全屏氛围片，不是产品演示片。判定标准：把截图缩到 30% 大小，能看出「一张有结构的网」，但读不出具体文字；标题压上去仍然清晰。
风格 = 工程仪器感：浅灰底、极淡墨线、品牌靛紫只出现在信号与注释上；不要深色科技感、不要发光、不要渐变。
节奏 = 一次呼吸：0s 最静 → 30s 最密 → 60s 回到起点，首尾同帧无缝循环。
</direction>

<structure>
1. 0–10s　网格与织物浮现，一条斜向亮带从右下扫入；脉冲零星，注释未出现
2. 10–25s　四条注释依次点亮（apps/server / apps/admin / packages/* / agent skills），每条停留约 6 秒
3. 25–35s　密度峰值：每 10 秒从某个节点扩散一圈极淡的涟漪；脉冲最密
4. 35–50s　第二条亮带（反方向）扫过；注释依次淡出
5. 50–60s　脉冲与呼吸回落到起点状态，末帧 = 首帧
</structure>

<build>
- 单个 HTML + `window.render(t)`，Canvas 2D；所有随机数带固定种子；不存帧间状态
- 周期函数一律用能整除 60 的周期（15 / 20 / 30 / 60），保证 t=0 与 t=60 完全一致
- 1920×1080、30fps、60 秒；先渲 960×540 低清小样对节奏，再出正式版
- 声音：numpy 合成 60 秒环境铺底（A2/E3/A3 叠泛音、轻微失谐）+ 与注释/涟漪对齐的极轻点击；`audio_tools.py normalize` 到 -14 LUFS
- 接页面：`apps/web/public/hero/` 放 mp4 + poster，hero 用 `muted loop playsinline preload="metadata"`，`prefers-reduced-motion` 时只显示 poster
</build>

<gotchas>
- 禁止项：深色背景、居中大字、所有元素淡入淡出、发光光斑、渐变、边框卡片
- 左侧 40% 是标题区，信号密度必须最低；注释只放右半屏
- 注释出现/消失必须在 60 秒内闭合并回到不可见，否则循环会闪烁
- 面积图/网格线不能比正文抢眼：墨线 alpha 不超过 0.12
</gotchas>

<start>
1. 按上面的分镜写 `index.html`，先渲 6 张静帧（0/10/25/35/50/60s）自检
2. 渲 960×540 低清全片，检查节奏与首尾帧
3. 合成音频、混流、出 `out/final.mp4`
4. `analyze_video` 抽帧打分，修到每项 ≥ 8 分
5. 放进 `apps/web/public/hero/`，改 `hero.tsx`，跑 `pnpm --filter web build` 验证
</start>
