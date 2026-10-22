#!/usr/bin/env python3
"""合成 60 秒循环铺底：A 调长音 + 极轻的气流 + 与画面事件对齐的点击。

循环要点：
- 所有振荡频率取整数 Hz（110 / 165 / 220 / 262 / 330），60 秒正好是整数个周期，首尾采样能接上；
- 气流噪声乘一条首尾为 0 的包络，避免循环处爆音；
- 点击事件都落在 9/15/21/27/50 秒（注释进场）与 10/20/30/40 秒（涟漪），最后一颗在 50 秒，
  60 秒前衰减完毕。
"""
import numpy as np
import wave
from pathlib import Path

SR = 48000
DUR = 60.0
N = int(SR * DUR)
t = np.arange(N) / SR

out_dir = Path(__file__).parent
out_dir.mkdir(exist_ok=True)


def smooth(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


# 整片包络：一次呼吸，0 与 60 秒都接近静
swell = 0.35 + 0.65 * (0.5 - 0.5 * np.cos(2 * np.pi * t / DUR))

# ---- 长音层 ----
def tone(freq, amp, detune=0.0, phase=0.0):
    return amp * np.sin(2 * np.pi * (freq + detune) * t + phase)


pad = np.zeros(N)
pad += tone(110, 0.16, -0.06) + tone(110, 0.14, 0.07, 1.1)      # A2 双振荡轻微失谐
pad += tone(165, 0.085, 0.05, 0.4)                               # E3
pad += tone(220, 0.06, -0.04, 2.0)                               # A3
pad += tone(262, 0.03, 0.03, 0.9)                                # C4（小三度，克制）
pad += tone(330, 0.014, 0.02, 2.6)                               # E4 泛音

# 极慢的音量起伏（15 秒一个周期，60 秒里 4 次，循环安全）
pad *= swell * (0.82 + 0.18 * np.sin(2 * np.pi * t / 15))

# ---- 气流层 ----
rng = np.random.default_rng(7)
noise = rng.standard_normal(N)
# 一阶低通，去掉刺耳高频
alpha = 0.02
air = np.empty(N)
acc = 0.0
for i in range(N):
    acc += alpha * (noise[i] - acc)
    air[i] = acc
air /= (np.max(np.abs(air)) + 1e-9)
air_env = 0.020 * swell * np.sin(np.pi * t / DUR) ** 0.5   # 首尾为 0
air *= air_env

# ---- 点击层：注释与涟漪的时间点 ----
clicks = []
for at, amp, freq in [
    (9, 0.030, 1320), (15, 0.026, 1320), (21, 0.026, 1180), (27, 0.030, 1320),
    (10, 0.018, 990), (20, 0.018, 990), (30, 0.020, 990), (40, 0.018, 990), (50, 0.016, 990),
]:
    start = int(at * SR)
    length = int(0.18 * SR)
    tt = np.arange(length) / SR
    env = np.exp(-tt * 26) * smooth(tt / 0.004)
    blip = np.sin(2 * np.pi * freq * tt) * env * amp
    clicks.append((start, blip))

click_track = np.zeros(N)
for start, blip in clicks:
    end = min(N, start + len(blip))
    click_track[start:end] += blip[: end - start]

# ---- 混音 ----
mono = pad + air + click_track
# 轻微立体声展宽：右声道给 pad 加 1.7ms 延迟
delay = int(0.0017 * SR)
right = np.copy(mono)
right[delay:] = 0.92 * right[delay:] + 0.16 * mono[:-delay]
left = mono

stereo = np.stack([left, right], axis=1)
# 峰值归一（留 1.5 dB 余量），随后再用 audio_tools normalize 到 -14 LUFS
peak = np.max(np.abs(stereo))
stereo = stereo / peak * 0.84

pcm = (stereo * 32767).astype(np.int16)
path = out_dir / "mix.wav"
with wave.open(str(path), "w") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())

print(f"wrote {path}  {pcm.shape[0] / SR:.2f}s  peak={np.max(np.abs(stereo)):.3f}")
