from PIL import Image, ImageDraw

GREEN_DARK = (47, 82, 51)
GREEN_MID = (74, 124, 89)
GREEN_LIGHT = (139, 179, 122)
ORANGE = (224, 121, 62)
CREAM = (250, 248, 244)


def draw_scene(size, bg_inset=0.0):
    """Draw the mountain/sun/trail scene onto a size x size canvas.
    bg_inset: fraction of size to inset content for maskable safe zone."""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # background rounded square (or full bleed for maskable)
    radius = int(size * (0.22 if bg_inset == 0 else 0))
    if bg_inset == 0:
        d.rounded_rectangle([0, 0, size, size], radius=radius, fill=GREEN_DARK)
    else:
        d.rectangle([0, 0, size, size], fill=GREEN_DARK)

    cx = size * 0.5
    horizon = size * (0.68 - bg_inset * 0.15)

    # sun
    sun_r = size * 0.11
    sun_cx = size * (0.68 - bg_inset * 0.05)
    sun_cy = size * (0.30 + bg_inset * 0.05)
    d.ellipse([sun_cx - sun_r, sun_cy - sun_r, sun_cx + sun_r, sun_cy + sun_r], fill=ORANGE)

    # back mountain (lighter), offset to the left so it peeks out
    back_peak = (cx - size * 0.20, horizon - size * 0.26)
    back_left = (cx - size * 0.46, horizon)
    back_right = (cx + size * 0.02, horizon)
    d.polygon([back_left, back_peak, back_right], fill=GREEN_LIGHT)

    # front mountain (mid), with a snow-cap notch
    peak = (cx + size * 0.06, horizon - size * 0.40)
    left = (cx - size * 0.16, horizon)
    right = (cx + size * 0.40, horizon)
    d.polygon([left, peak, right], fill=GREEN_MID)

    # snow cap
    snow_l = (peak[0] - size * 0.075, peak[1] + size * 0.10)
    snow_r = (peak[0] + size * 0.075, peak[1] + size * 0.10)
    d.polygon([snow_l, peak, snow_r], fill=CREAM)

    # ground band
    d.rectangle([0, horizon, size, size], fill=GREEN_DARK)
    d.polygon([
        (0, horizon + size * 0.02),
        (size, horizon - size * 0.01),
        (size, size),
        (0, size),
    ], fill=(38, 66, 41, 255))

    # trail (dotted curve) leading to base
    dot_r = max(1, size * 0.014)
    trail_pts = [
        (cx - size * 0.02, size * 0.98),
        (cx + size * 0.03, size * 0.90),
        (cx - size * 0.01, size * 0.82),
        (cx + size * 0.04, size * 0.74),
    ]
    for px, py in trail_pts:
        if py > horizon:
            d.ellipse([px - dot_r, py - dot_r, px + dot_r, py + dot_r], fill=CREAM)

    return img


def save(size, path, maskable=False):
    img = draw_scene(size, bg_inset=0.12 if maskable else 0.0)
    img.save(path)
    print('wrote', path, img.size)


if __name__ == '__main__':
    import os
    os.makedirs('icons', exist_ok=True)
    save(180, 'icons/icon-180.png')
    save(192, 'icons/icon-192.png')
    save(512, 'icons/icon-512.png')
    save(512, 'icons/icon-512-maskable.png', maskable=True)
    save(32, 'icons/favicon-32.png')
