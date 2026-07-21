#!/usr/bin/env python3
"""Render the SatIdentifier app icon: a star field, the accent-blue FOV
rectangle, and a warm satellite trail crossing it with a motion arrowhead —
the three things the app is actually about. Companion to SatObserver-MX's
globe icon, same pipeline: 1024 px master -> iconset -> .icns (macOS) and
.ico (Windows). Dev-time only; outputs are committed.

Run:  python3 make_icon.py          (needs pillow)
then: iconutil -c icns SatIdentifier.iconset -o SatIdentifier.icns
"""

import math
import pathlib
import random

from PIL import Image, ImageDraw, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
S = 1024

BG_TOP = (12, 16, 24)
BG_BOT = (16, 22, 34)
ACCENT = (79, 195, 247)      # --accent, the FOV box
TRAIL = (255, 213, 79)       # PAY yellow, the dominant trail colour
STAR = (225, 235, 255)


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def main():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # vertical gradient background
    for y in range(S):
        f = y / S
        col = tuple(int(a + (b - a) * f) for a, b in zip(BG_TOP, BG_BOT))
        d.line([(0, y), (S, y)], fill=col + (255,))

    # star field — deterministic, so the icon is reproducible
    rng = random.Random(20260721)
    for _ in range(240):
        x, y = rng.uniform(40, S - 40), rng.uniform(40, S - 40)
        mag = rng.random()
        r = 1.5 + 4.5 * mag * mag
        a = int(110 + 145 * mag)
        d.ellipse([x - r, y - r, x + r, y + r], fill=STAR + (a,))
    # a few bright ones with a soft glow
    for x, y, r in [(210, 240, 9), (760, 180, 8), (330, 800, 8), (880, 700, 7)]:
        glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        gd.ellipse([x - 3 * r, y - 3 * r, x + 3 * r, y + 3 * r], fill=STAR + (70,))
        glow = glow.filter(ImageFilter.GaussianBlur(10))
        img.alpha_composite(glow)
        d.ellipse([x - r, y - r, x + r, y + r], fill=STAR + (255,))

    # FOV rectangle, accent blue, slightly off-centre like a real chart
    box = [232, 302, 792, 722]
    for w, a in [(26, 60), (14, 150), (8, 255)]:     # layered stroke = soft neon edge
        d.rounded_rectangle(box, radius=26, outline=ACCENT + (a,), width=w)

    # the trail: a gentle arc crossing the box corner to corner, drawn as many
    # blobs so it can widen toward the arrow end
    p0, p1, p2 = (96, 852), (520, 560), (940, 176)   # quadratic Bezier
    trail = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    td = ImageDraw.Draw(trail)
    n = 260
    for i in range(n):
        t = i / (n - 1)
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]
        r = 10 + 16 * t                              # brightens/widens along motion
        a = int(120 + 135 * t)
        td.ellipse([x - r, y - r, x + r, y + r], fill=TRAIL + (a,))
    trail = trail.filter(ImageFilter.GaussianBlur(3))
    img.alpha_composite(trail)

    # arrowhead at the trail's end, pointing along the motion
    tx = 2 * (p2[0] - p1[0])
    ty = 2 * (p2[1] - p1[1])
    L = math.hypot(tx, ty)
    ux, uy = tx / L, ty / L
    tipx, tipy = p2[0] + ux * 26, p2[1] + uy * 26
    arm = 92
    for sign in (1, -1):
        ax = tipx - arm * (ux * math.cos(0.5) - sign * uy * math.sin(0.5))
        ay = tipy - arm * (uy * math.cos(0.5) + sign * ux * math.sin(0.5))
        d.line([(tipx, tipy), (ax, ay)], fill=TRAIL + (255,), width=34)

    # macOS-style rounded square
    img.putalpha(rounded_mask(S, 184))

    out = HERE / "icon_1024.png"
    img.save(out)
    print("wrote", out)

    iconset = HERE / "SatIdentifier.iconset"
    iconset.mkdir(exist_ok=True)
    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        img.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        img.resize((sz * 2, sz * 2), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}@2x.png")
    print("wrote", iconset)

    ico = HERE / "SatIdentifier.ico"
    img.save(ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", ico)


if __name__ == "__main__":
    main()
