# QA / 自检

## 成片

- 路径：`out/final.mp4`（1920×1080 / 30fps / 60.00s / 含音轨）
- 网页版：`apps/web/public/hero/scaffold-hero.mp4`（CRF 22，4.1 MB）+ `scaffold-hero.jpg`（68 KB）
- 循环：首帧与末帧 PSNR **48.9 dB**（只剩编码噪声），页面里 `loop` 不会跳帧

## 打分（背景片口径：不抢首屏标题）

| 项 | 分 | 说明 |
| --- | --- | --- |
| 开场 | 8 | 0–2s 只有呼吸与零星脉冲；作为背景片刻意安静，不做钩子 |
| 手机可读 | 8 | 页面文字清楚；**片内标注在 390px 宽时贴近右边缘**（已知问题） |
| 动作 | 8 | 行波 + 16px 漂移 + 1.4% 呼吸，60 秒没有完全静止的空拍 |
| 变化 | 9 | 6 条标注每 5 秒进场一条，每 10 秒一圈涟漪 |
| 构图 | 8 | 左侧 40% 最安静，密度集中在右侧；标注都有引导线与锚点 |
| 贴合原材料 | 9 | apps/web、apps/admin、apps/server、packages/*、pnpm bootstrap、17 skills 均来自仓库；品牌色 `#6057e7`、Geist / Space Grotesk 取自站点构建产物 |
| 声画同步 | 8 | 点击落在标注进场（4/9/13/19/24/29s）与涟漪（10/20/30/40/50s）上 |

## 最严重的三个问题

1. **移动端标注贴边**（时间点：9–45s）—— 16:9 视频在竖屏用 `object-cover` 裁掉两侧，右侧标注只剩一半。后续可出一版 9:16 裁切版，或把标注改到画面中右 70% 以内。
2. **标注字号偏小**（全片）—— 1920 下 20px，缩到 390px 宽只剩 4px，手机上读不出，只能当纹理。
3. **开场没有强钩子**（0–3s）—— 背景片的取舍；如果以后要用在 landing 视频位（非背景），需要重做前 3 秒。

## 声音

- `audio/mix-final.wav`：-14.1 LUFS / 真峰 -4.1 dBTP；波形无削顶、无静音段
- 循环：所有振荡取整数 Hz（110/165/220/262/330），60 秒为整数周期；气流噪声包络首尾为 0

## 复现

```bash
cd opus-video/billy-hero-ambient
.venv/bin/python audio/make_bed.py
.venv/bin/python /Users/rihel/.agents/skills/xilo-opus-video/scripts/audio_tools.py normalize audio/mix.wav audio/mix-norm.wav
ffmpeg -y -i audio/mix-norm.wav -af "volume=-1.2dB" audio/mix-final.wav
.venv/bin/python /Users/rihel/.agents/skills/xilo-opus-video/scripts/render.py index.html out/final.mp4 \
  --size 1920x1080 --fps 30 --duration 60 --audio audio/mix-final.wav --crf 18
```
