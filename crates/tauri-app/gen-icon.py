#!/usr/bin/env python3
# 生成 icon-source.svg：Apple 风 squircle（超椭圆）底 + teal 串口插头字形。
#
# 对齐 Apple macOS 应用图标规范：
# - 1024 画布，四周留 100px 透明边距（可见图形 ~824px，即 80%）—— macOS 图标需此留白，
#   否则比系统图标显大。
# - 底色用真 squircle（超椭圆 n≈5），非圆弧矩形—— Apple 的连续曲线圆角，圆弧矩形对不上。
#
# 改 n / ART / PAD 后重跑：python gen-icon.py（输出 icon-source.svg）。
# 再 `cargo tauri icon icon-source.svg -o icons` 生成全套。
import math

N = 5.0      # 超椭圆指数（Apple squircle 近似）
ART = 824    # 可见图形边长（1024 - 2*100 留白）
PAD = 100
A = ART / 2  # 半边 = 412
CX = CY = 512.0
PTS = 256    # 路径采样点（够平滑）

parts = []
for i in range(PTS):
    t = 2 * math.pi * i / PTS
    c, s = math.cos(t), math.sin(t)
    x = CX + A * math.copysign(abs(c) ** (2 / N), c)
    y = CY + A * math.copysign(abs(s) ** (2 / N), s)
    parts.append(f"{x:.1f} {y:.1f}")
squircle = "M " + " L ".join(parts) + " Z"

# 字形（IconPlug，24-viewBox）缩放到图形的 ~53%，居中
glyph_size = ART * 0.53          # ~437
scale = glyph_size / 24          # ~18.2
off = (1024 - glyph_size) / 2    # ~293.5
glyph_tf = f"translate({off:.1f} {off:.1f}) scale({scale:.2f})"

svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <path d="{squircle}" fill="#efebe2" />
  <g transform="{glyph_tf}" fill="none" stroke="#0c7f73" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 2v6" />
    <path d="M15 2v6" />
    <rect x="7" y="8" width="10" height="6" rx="1.5" />
    <path d="M9 14v3a3 3 0 0 0 6 0v-3" />
    <path d="M12 20v2" />
  </g>
</svg>
"""

with open("icon-source.svg", "w", encoding="utf-8") as f:
    f.write(svg)
print(f"wrote icon-source.svg: squircle n={N}, art={ART}px (pad {PAD}), glyph {glyph_size:.0f}px")
