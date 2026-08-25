"""Regenerate the raster brand assets in admin/public/ from the mark geometry.

    python admin/scripts/render-icons.py        # needs Pillow

The SVGs (public/logo-mark.svg, public/favicon.svg) are the source of truth for
the mark; the ratios below mirror them so the PNG/ICO set can be rebuilt without
a headless browser or an SVG rasteriser in the toolchain. Change one, change the
other — and components/Brand.tsx and agent/agent/tray.py carry the same shape.

Everything is drawn at 8x and downsampled: Pillow has no round line caps, so
each stroke is a line or arc plus explicit end-cap discs, and the supersample is
what keeps those joins from showing.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public"
G0, G1 = (0x6C, 0x2B, 0xF0), (0x4A, 0x0F, 0xC0)   # badge gradient
DARK = (0x14, 0x00, 0x4A)                         # raised-slab shadow
WHITE = (0xFF, 0xFF, 0xFF)
SS = 8


def gradient(size):
    """Diagonal top-left -> bottom-right ramp, matching the SVG linearGradient."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(G0, G1))
    return img


def rounded_mask(size, box, radius):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle(box, radius=radius, fill=255)
    return m


def cap(d, x, y, w, color):
    r = w / 2
    d.ellipse((x - r, y - r, x + r, y + r), fill=color)


def seg(d, p, q, w, color):
    d.line((p[0], p[1], q[0], q[1]), fill=color, width=round(w))
    cap(d, p[0], p[1], w, color)
    cap(d, q[0], q[1], w, color)


def ring(d, cx, cy, r, a0, a1, w, color):
    d.arc((cx - r, cy - r, cx + r, cy + r), a0, a1, fill=color, width=round(w))
    for a in (a0, a1):
        cap(d, cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a)), w, color)


def clock(d, cx, cy, r, stroke, arm, color, motion_arc=True):
    """Dial broken between 1 and 4 o'clock, with three hands spelling a T."""
    ring(d, cx, cy, r, 45, 300, stroke, color)
    seg(d, (cx - r * 0.83, cy), (cx, cy), arm, color)
    seg(d, (cx, cy), (cx, cy + r * 0.83), arm, color)
    seg(d, (cx, cy), (cx + r * 1.20 * math.cos(math.radians(320)),
                      cy + r * 1.20 * math.sin(math.radians(320))), arm, color)
    if motion_arc:
        ring(d, cx, cy, r * 0.60, 200, 295, r * 0.05, color)


def render(px, detailed):
    """detailed -> full mark with the raised slab; else the flat favicon cut."""
    s = px * SS
    badge = ((0.1543 * s, 0.1230 * s, 0.8184 * s, 0.8496 * s) if detailed
             else (0.031 * s, 0.031 * s, 0.969 * s, 0.969 * s))
    radius = 0.125 * s if detailed else 0.219 * s

    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    if detailed:
        off = 0.0273 * s
        shadow = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        ImageDraw.Draw(shadow).rounded_rectangle(
            [badge[0] + off, badge[1] + off, badge[2] + off, badge[3] + off],
            radius=radius, fill=DARK + (255,))
        out.alpha_composite(shadow)

    tile = gradient(s).convert("RGBA")
    tile.putalpha(rounded_mask(s, badge, radius))
    out.alpha_composite(tile)

    cx, cy = (badge[0] + badge[2]) / 2, (badge[1] + badge[3]) / 2
    r = (badge[2] - badge[0]) * (0.33 if detailed else 0.27)
    stroke = r * (0.125 if detailed else 0.19)
    arm = r * (0.165 if detailed else 0.24)

    if detailed:
        # The hands' own shadow, clipped to the tile so it cannot spill past the
        # rounded corner onto the transparent margin.
        layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
        o = 0.0156 * s
        clock(ImageDraw.Draw(layer), cx + o, cy + o, r, stroke, arm, DARK + (255,))
        layer.putalpha(Image.composite(layer.getchannel("A"), Image.new("L", (s, s), 0),
                                       rounded_mask(s, badge, radius)))
        out.alpha_composite(layer)

    face = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    clock(ImageDraw.Draw(face), cx, cy, r, stroke, arm, WHITE + (255,), motion_arc=detailed)
    out.alpha_composite(face)

    return out.resize((px, px), Image.LANCZOS)


def full_bleed(px):
    """No slab, no transparent margin — for surfaces that impose their own mask.

    The mark spans ~47% of the tile, well inside the 80% maskable safe zone, so
    Android's circle crop and iOS's superellipse both clear it.
    """
    s = px * SS
    img = gradient(s).convert("RGBA")
    r = s * 0.2667
    clock(ImageDraw.Draw(img), s / 2, s / 2, r, r * 0.19, r * 0.24, WHITE + (255,),
          motion_arc=False)
    return img.resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    render(512, True).save(OUT / "icon-512.png")
    render(192, True).save(OUT / "icon-192.png")

    full_bleed(180).convert("RGB").save(OUT / "apple-touch-icon.png")
    full_bleed(512).save(OUT / "icon-maskable-512.png")

    # 16/32/48 only. Modern browsers take favicon.svg; the .ico is the legacy
    # fallback, and packing 128/256 into it triples a file that clients refetch
    # on every cold load for no visible gain.
    render(48, False).save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    print(f"wrote raster assets to {OUT}")
