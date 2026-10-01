#!/usr/bin/env python3
# 生成 icon-source.svg：Apple 标准 squircle 底 + teal 串口插头字形。
#
# 对齐 Apple macOS 应用图标规范：
# - 1024 画布，四周留 100px 透明边距（可见图形 ~824px，即 80%）—— macOS 图标需此留白，
#   否则比系统图标显大。
# - 底形用 Apple 标准连续曲率圆角（平滑圆角矩形）：直边 → 三次贝塞尔 → 圆弧 →
#   三次贝塞尔拼接，曲率连续；既非圆弧矩形（G1 不连续），也非整体超椭圆（无平直
#   边、角部偏尖，与系统图标并排能看出差别）。构造同 Figma「corner smoothing」
#   （figma.com/blog/desperately-seeking-squircles；实现按 MartinRGB/
#   Figma_Squircles_Approximation 与 figma-squircle 移植）。
#   参数按本机 macOS 系统图标实测（遮罩 412px@512 亚像素边界最小二乘）：圆角
#   半径 = 图形边长 × 0.225（824 → 185.4），平滑系数 ξ = 0.6（Figma 匹配
#   Apple 图标的取值）；残差 rms ≈ 0.3px@512。
#
# 改 RADIUS_F / SMOOTHING / ART / PAD 后重跑：python gen-icon.py（输出 icon-source.svg）。
# 再 `cargo tauri icon icon-source.svg -o icons` 生成全套。
import math

ART = 824          # 可见图形边长（1024 - 2*100 留白）
PAD = 100
A = ART / 2        # 半边 = 412
CX = CY = 512.0

RADIUS_F = 0.225   # 圆角半径 / 图形边长（824 → 185.4，Apple 图标实测）
SMOOTHING = 0.6    # 平滑系数 ξ：0=普通圆角矩形，0.6≈Apple 图标形状

# ---- 单个圆角区的参数（figma-squircle 的 getPathParamsForCorner）----
R = ART * RADIUS_F
xi = min(SMOOTHING, A / R - 1.0)        # 空间不足时压低平滑（Figma 的回退）
p = (1.0 + xi) * R                       # 圆角区沿边的总占用
arc_measure = 90.0 * (1.0 - xi)          # 圆弧角度（ξ=0 时 90°，越大弧越短）
arc_len = math.sin(math.radians(arc_measure) / 2.0) * R * math.sqrt(2.0)  # 圆弧弦长
angle_alpha = math.radians((90.0 - arc_measure) / 2.0)
p3p4 = R * math.tan(angle_alpha / 2.0)   # 控制点 P3、P4 间距
angle_beta = math.radians(45.0 * xi)
c = p3p4 * math.cos(angle_beta)
d = c * math.tan(angle_beta)
b = (p - arc_len - c - d) / 3.0
a = 2.0 * b


def f(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


lo, hi = PAD, PAD + ART
squircle = f"""
    M {f(hi - p)} {f(lo)}
    c {f(a)} 0 {f(a + b)} 0 {f(a + b + c)} {f(d)}
    a {f(R)} {f(R)} 0 0 1 {f(arc_len)} {f(arc_len)}
    c {f(d)} {f(c)} {f(d)} {f(b + c)} {f(d)} {f(a + b + c)}
    L {f(hi)} {f(hi - p)}
    c 0 {f(a)} 0 {f(a + b)} {f(-d)} {f(a + b + c)}
    a {f(R)} {f(R)} 0 0 1 {f(-arc_len)} {f(arc_len)}
    c {f(-c)} {f(d)} {f(-(b + c))} {f(d)} {f(-(a + b + c))} {f(d)}
    L {f(lo + p)} {f(hi)}
    c {f(-a)} 0 {f(-(a + b))} 0 {f(-(a + b + c))} {f(-d)}
    a {f(R)} {f(R)} 0 0 1 {f(-arc_len)} {f(-arc_len)}
    c {f(-d)} {f(-c)} {f(-d)} {f(-(b + c))} {f(-d)} {f(-(a + b + c))}
    L {f(lo)} {f(lo + p)}
    c 0 {f(-a)} 0 {f(-(a + b))} {f(d)} {f(-(a + b + c))}
    a {f(R)} {f(R)} 0 0 1 {f(arc_len)} {f(-arc_len)}
    c {f(c)} {f(-d)} {f(b + c)} {f(-d)} {f(a + b + c)} {f(-d)}
    Z"""

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

with open("icon-source.svg", "w", encoding="utf-8") as fp:
    fp.write(svg)
print(f"wrote icon-source.svg: Apple squircle R={R:.1f} xi={SMOOTHING}, art={ART}px (pad {PAD}), glyph {glyph_size:.0f}px")
