#!/usr/bin/env python3
"""Draw the tray's state icons into assets/app-icon/tray (#75).

The panel draws tray icons at about 16-20 px, so a state shown as a small badge on the app icon is hard to notice.
Syncing, paused and error get a full-size icon of their own instead, drawn in white outline like the system icons
beside them. Syncing is a set of frames the tray cycles through, so the arrows turn. The idle icon (the Proton folder
with its check badge) is left as it is, so the app stays recognisable while all is well.

Run: python3 scripts/make-tray-icons.py
"""

import math
import os

import cairo

SIZE = 64
# Thick enough to stay a solid line when the panel scales 64 px down to 16 px
STROKE = 7.0
WHITE = (1.0, 1.0, 1.0)
AMBER = (0.98, 0.70, 0.18)
# Two arrows turn back onto themselves after half a turn, so the frames cover 180 degrees
SYNC_FRAMES = 8

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "app-icon", "tray")


def surface():
    s = cairo.ImageSurface(cairo.FORMAT_ARGB32, SIZE, SIZE)
    ctx = cairo.Context(s)
    ctx.set_line_cap(cairo.LINE_CAP_ROUND)
    ctx.set_line_join(cairo.LINE_JOIN_ROUND)
    return s, ctx


def arrow_head(ctx, cx, cy, r, at, ahead, half_width):
    """A filled triangle sitting on the circle: its base straddles the circle at angle `at`, square to it, and its
    tip lies on the circle `ahead` radians further on, so it follows the arc instead of sticking out."""
    bx, by = cx + r * math.cos(at), cy + r * math.sin(at)
    ux, uy = math.cos(at), math.sin(at)
    tip = at + ahead
    ctx.move_to(bx + ux * half_width, by + uy * half_width)
    ctx.line_to(cx + r * math.cos(tip), cy + r * math.sin(tip))
    ctx.line_to(bx - ux * half_width, by - uy * half_width)
    ctx.close_path()
    ctx.fill()


def draw_sync(rotation):
    """Two arcs chasing each other round a circle, each ending in an arrowhead."""
    s, ctx = surface()
    ctx.set_source_rgb(*WHITE)
    ctx.set_line_width(STROKE)
    cx = cy = SIZE / 2
    r = SIZE / 2 - STROKE - 4
    gap = math.radians(70)
    head = math.radians(30)
    for half in (0, math.pi):
        start = rotation + half + gap / 2
        end = rotation + half + math.pi - gap / 2
        ctx.new_path()
        ctx.arc(cx, cy, r, start, end)
        ctx.stroke()
        # Clockwise is increasing angle in cairo, so the head points on past the arc's end
        arrow_head(ctx, cx, cy, r, end, head, STROKE * 1.25)
    return s


def draw_paused():
    """Two rounded bars inside a circle."""
    s, ctx = surface()
    ctx.set_source_rgb(*WHITE)
    ctx.set_line_width(STROKE)
    cx = cy = SIZE / 2
    ctx.arc(cx, cy, SIZE / 2 - STROKE / 2 - 3, 0, 2 * math.pi)
    ctx.stroke()
    bar = SIZE * 0.30
    for dx in (-SIZE * 0.11, SIZE * 0.11):
        ctx.move_to(cx + dx, cy - bar / 2)
        ctx.line_to(cx + dx, cy + bar / 2)
        ctx.stroke()
    return s


def draw_error():
    """A warning triangle with an exclamation mark, in amber so it reads as a problem at a glance."""
    s, ctx = surface()
    ctx.set_source_rgb(*AMBER)
    ctx.set_line_width(STROKE)
    m = STROKE / 2 + 3
    top = (SIZE / 2, m + 2)
    left = (m, SIZE - m - 2)
    right = (SIZE - m, SIZE - m - 2)
    ctx.move_to(*top)
    ctx.line_to(*right)
    ctx.line_to(*left)
    ctx.close_path()
    ctx.stroke()
    cx = SIZE / 2
    ctx.move_to(cx, SIZE * 0.36)
    ctx.line_to(cx, SIZE * 0.60)
    ctx.stroke()
    ctx.arc(cx, SIZE * 0.74, STROKE * 0.62, 0, 2 * math.pi)
    ctx.fill()
    return s


def main():
    os.makedirs(OUT, exist_ok=True)
    step = math.pi / SYNC_FRAMES
    for i in range(SYNC_FRAMES):
        draw_sync(i * step).write_to_png(os.path.join(OUT, f"protondrive-tray-syncing-{i}.png"))
    # The plain name stays, for anything that asks for the syncing icon without a frame
    draw_sync(0).write_to_png(os.path.join(OUT, "protondrive-tray-syncing.png"))
    draw_paused().write_to_png(os.path.join(OUT, "protondrive-tray-paused.png"))
    draw_error().write_to_png(os.path.join(OUT, "protondrive-tray-error.png"))


if __name__ == "__main__":
    main()
