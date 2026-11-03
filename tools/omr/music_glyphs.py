#!/usr/bin/env python3
"""Rasterise GNU FreeSerif music glyphs (and bold digits) into anti-aliased
alpha masks, for the synthetic score generator and the OMR template exporter.

Everything is expressed in *staff spaces* (sp): FreeSerif draws its
five-line staff glyph (U+1D11A) with 191 font units per staff space and the
line centres at y = -12, 179, 370, 561, 752 (bottom line -> top line,
y grows upward in font units).  A glyph is placed by giving a pixel position
for one of its "anchors" (e.g. the G line for the treble clef, the loop centre
for a flat) so that the caller never has to know font-unit geometry.
"""
import numpy as np
from PIL import Image, ImageDraw
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.boundsPen import BoundsPen

SERIF = '/usr/share/fonts/truetype/freefont/FreeSerif.ttf'
SERIF_BOLD = '/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf'
UPS = 191.0                              # font units per staff space
LINE_Y = [-12, 179, 370, 561, 752]       # staff line centres, bottom -> top (font units)
SUPER = 4                                # supersampling factor for anti-aliasing

# name -> (font, codepoint, anchor, extra uniform scale)
# anchor: 'center' | 'left-center' | 'left-top' | 'left-bottom' | 'inner-center' |
#         ('left-y', fontUnitsY) — the anchor point is placed at the requested pixel.
GLYPHS = {
    'gClef':      ('serif', 0x1D11E, ('left-y', LINE_Y[1]), 1.0),
    'fClef':      ('serif', 0x1D122, ('left-y', LINE_Y[3]), 1.0),
    'cClef':      ('serif', 0x1D121, ('left-y', LINE_Y[2]), 1.0),
    'noteheadBlack': ('serif', 0x1D158, 'center', 1.0),
    'noteheadHalf':  ('serif', 0x1D157, 'center', 1.0),
    'noteheadWhole': ('serif', 0x1D15D, 'center', 1.0),
    'sharp':      ('serif', 0x266F, 'center', 0.56),
    'flat':       ('serif', 0x266D, 'inner-center', 0.57),
    'natural':    ('serif', 0x266E, 'center', 0.54),
    'restWhole':  ('serif', 0x1D13B, ('left-y', LINE_Y[2]), 1.0),
    'restHalf':   ('serif', 0x1D13C, ('left-y', LINE_Y[2]), 1.0),
    'restQuarter': ('serif', 0x1D13D, ('left-y', LINE_Y[2]), 1.0),
    'rest8th':    ('serif', 0x1D13E, ('left-y', LINE_Y[2]), 1.0),
    'rest16th':   ('serif', 0x1D13F, ('left-y', LINE_Y[2]), 1.0),
    'rest32nd':   ('serif', 0x1D140, ('left-y', LINE_Y[2]), 1.0),
    'flag8th':    ('serif', 0x1D16E, 'left-top', 0.85),
    'flag16th':   ('serif', 0x1D16F, 'left-top', 0.85),
    'flag32nd':   ('serif', 0x1D170, 'left-top', 0.85),
    'brace':      ('serif', 0x1D114, ('left-y', LINE_Y[2]), 1.0),
    'common':     ('serif', 0x1D134, ('left-y', LINE_Y[2]), 1.0),
    'cut':        ('serif', 0x1D135, ('left-y', LINE_Y[2]), 1.0),
    'dot':        ('serif', 0x1D16D, 'center', 1.0),
}
# Bold digits scaled so that the digit height (688 units) is 2 staff spaces.
for _d in '0123456789':
    GLYPHS['digit' + _d] = ('bold', ord(_d), 'left-bottom', 2.0 * UPS / 688.0)

_fonts = {}


def _font(kind):
    if kind not in _fonts:
        f = TTFont(SERIF if kind == 'serif' else SERIF_BOLD)
        _fonts[kind] = (f, f.getBestCmap(), f.getGlyphSet())
    return _fonts[kind]


def _flatten(glyphset, name, tol=3.0):
    """Glyph outline -> list of polygons (font units). Quadratic/cubic
    segments are subdivided finely enough for 4x supersampling."""
    rp = DecomposingRecordingPen(glyphset)
    glyphset[name].draw(rp)
    polys, cur, start = [], [], None
    for op, args in rp.value:
        if op == 'moveTo':
            if cur: polys.append(cur)
            cur = [args[0]]; start = args[0]
        elif op == 'lineTo':
            cur.append(args[0])
        elif op == 'qCurveTo':
            pts = list(args)
            if pts[-1] is None:          # closed all-off-curve contour
                pts[-1] = ((pts[0][0] + pts[-2][0]) / 2, (pts[0][1] + pts[-2][1]) / 2)
            p0 = cur[-1]
            offs, end = pts[:-1], pts[-1]
            for i, c in enumerate(offs):
                p2 = end if i == len(offs) - 1 else ((c[0] + offs[i + 1][0]) / 2, (c[1] + offs[i + 1][1]) / 2)
                n = max(3, int(np.hypot(p2[0] - p0[0], p2[1] - p0[1]) / tol))
                for k in range(1, n + 1):
                    t = k / n
                    cur.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * c[0] + t * t * p2[0],
                                (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * c[1] + t * t * p2[1]))
                p0 = p2
        elif op == 'curveTo':
            p0 = cur[-1]; c1, c2, p3 = args
            n = max(4, int(np.hypot(p3[0] - p0[0], p3[1] - p0[1]) / tol))
            for k in range(1, n + 1):
                t = k / n; u = 1 - t
                cur.append((u ** 3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t ** 3 * p3[0],
                            u ** 3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t ** 3 * p3[1]))
        elif op in ('closePath', 'endPath'):
            if cur: polys.append(cur)
            cur = []
    if cur: polys.append(cur)
    return [p for p in polys if len(p) >= 3]


def _signed_area(poly):
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i]; x1, y1 = poly[(i + 1) % len(poly)]
        a += x0 * y1 - x1 * y0
    return a / 2


def rasterize_polys(polys, sx, sy, super_=SUPER):
    """Fill polygons (nonzero winding) given in some unit system scaled by
    (sx, sy) pixels/unit; y is flipped (font y up -> image y down).
    Returns (alpha float32 HxW in 0..1, (ox, oy)) where (ox, oy) is the pixel
    position of the array's top-left corner relative to the unit origin."""
    xs = [p[0] * sx for poly in polys for p in poly]
    ys = [-p[1] * sy for poly in polys for p in poly]
    x0, x1 = int(np.floor(min(xs))) - 1, int(np.ceil(max(xs))) + 1
    y0, y1 = int(np.floor(min(ys))) - 1, int(np.ceil(max(ys))) + 1
    W, H = x1 - x0, y1 - y0
    acc = np.zeros((H * super_, W * super_), np.int16)
    for poly in polys:
        pts = [((p[0] * sx - x0) * super_, (-p[1] * sy - y0) * super_) for p in poly]
        # font y is flipped, so the sign of the image-space area is inverted
        sign = -1 if _signed_area(pts) > 0 else 1
        m = Image.new('L', (W * super_, H * super_), 0)
        ImageDraw.Draw(m).polygon(pts, fill=1)
        acc += sign * np.asarray(m, dtype=np.int16)
    hi = Image.fromarray(((acc != 0) * 255).astype(np.uint8))
    lo = hi.resize((W, H), Image.BOX)
    return np.asarray(lo, dtype=np.float32) / 255.0, (x0, y0)


class GlyphRaster:
    """Cache of rasterised glyphs keyed by (name, sp, yscale)."""

    def __init__(self):
        self.cache = {}
        self.outlines = {}

    def outline(self, name):
        if name not in self.outlines:
            kind, cp, anchor, scale = GLYPHS[name]
            f, cmap, gs = _font(kind)
            gname = cmap[cp]
            polys = _flatten(gs, gname)
            polys = [[(x * scale, y * scale) for x, y in poly] for poly in polys]
            xs = [p[0] for poly in polys for p in poly]; ys = [p[1] for poly in polys for p in poly]
            bbox = (min(xs), min(ys), max(xs), max(ys))
            adv = gs[gname].width * scale
            if anchor == 'center':
                ax, ay = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
            elif anchor == 'left-center':
                ax, ay = bbox[0], (bbox[1] + bbox[3]) / 2
            elif anchor == 'left-top':
                ax, ay = bbox[0], bbox[3]
            elif anchor == 'left-bottom':
                ax, ay = bbox[0], bbox[1]
            elif anchor == 'inner-center':      # centre of the smallest contour (flat's loop)
                small = min(polys, key=lambda p: abs(_signed_area(p)))
                sy = [q[1] for q in small]
                ax, ay = bbox[0], (min(sy) + max(sy)) / 2
            else:
                ax, ay = bbox[0], anchor[1] * scale
            self.outlines[name] = (polys, bbox, (ax, ay), adv)
        return self.outlines[name]

    def size_sp(self, name):
        """(width, height) of the glyph in staff spaces."""
        _, b, _, _ = self.outline(name)
        return (b[2] - b[0]) / UPS, (b[3] - b[1]) / UPS

    def anchor_offsets_sp(self, name):
        """bbox relative to the anchor, in sp, image orientation (y down):
        returns (left, top, right, bottom)."""
        _, b, (ax, ay), _ = self.outline(name)
        return ((b[0] - ax) / UPS, -(b[3] - ay) / UPS, (b[2] - ax) / UPS, -(b[1] - ay) / UPS)

    def render(self, name, sp, yscale=1.0, flip_y=False):
        """Alpha mask + offset of its top-left relative to the anchor pixel."""
        key = (name, round(sp, 3), round(yscale, 3), flip_y)
        if key in self.cache:
            return self.cache[key]
        polys, bbox, (ax, ay), _ = self.outline(name)
        s = sp / UPS
        shifted = [[(x - ax, (ay - y) if flip_y else (y - ay)) for x, y in poly] for poly in polys]
        alpha, (ox, oy) = rasterize_polys(shifted, s, s * yscale)
        self.cache[key] = (alpha, ox, oy)
        return self.cache[key]


def blit(page, alpha, x, y, ink=0.0):
    """Composite an alpha mask (float 0..1) of ink colour onto a float page
    array at integer top-left (x, y); clipped to the page."""
    H, W = page.shape
    h, w = alpha.shape
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    a = alpha[y0 - y:y1 - y, x0 - x:x1 - x]
    roi = page[y0:y1, x0:x1]
    roi *= (1 - a)
    roi += a * ink


def draw_glyph(page, gr, name, sp, ax, ay, yscale=1.0, flip_y=False):
    """Draw a glyph with its anchor at pixel (ax, ay). Returns the ink bbox
    [x, y, w, h] in page pixels."""
    alpha, ox, oy = gr.render(name, sp, yscale, flip_y)
    x = int(round(ax)) + ox
    y = int(round(ay)) + oy
    blit(page, alpha, x, y)
    return [x, y, alpha.shape[1], alpha.shape[0]]


def fill_polygon(page, pts):
    """Anti-aliased polygon fill, points in page pixels (float)."""
    alpha, (ox, oy) = rasterize_polys([[(x, -y) for x, y in pts]], 1.0, 1.0)
    blit(page, alpha, ox, oy)


def fill_rect(page, x0, y0, x1, y1):
    fill_polygon(page, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)])


if __name__ == '__main__':
    # quick visual self-test: render a few glyphs on a staff at sp = 14
    gr = GlyphRaster()
    sp = 14
    page = np.full((160, 420), 255.0, np.float32)
    top = 60
    for i in range(5):
        fill_rect(page, 10, top + i * sp - 0.6, 410, top + i * sp + 0.6)
    draw_glyph(page, gr, 'gClef', sp, 20, top + 3 * sp)
    draw_glyph(page, gr, 'sharp', sp, 60, top)
    draw_glyph(page, gr, 'flat', sp, 75, top + 2 * sp)
    draw_glyph(page, gr, 'digit4', sp, 95, top + 2 * sp)
    draw_glyph(page, gr, 'digit4', sp, 95, top + 4 * sp)
    draw_glyph(page, gr, 'noteheadBlack', sp, 140, top + 1.5 * sp)
    draw_glyph(page, gr, 'noteheadHalf', sp, 170, top + 2 * sp)
    draw_glyph(page, gr, 'noteheadWhole', sp, 200, top + 3 * sp)
    draw_glyph(page, gr, 'restQuarter', sp, 230, top + 2 * sp)
    draw_glyph(page, gr, 'rest8th', sp, 255, top + 2 * sp)
    draw_glyph(page, gr, 'rest16th', sp, 275, top + 2 * sp)
    draw_glyph(page, gr, 'restWhole', sp, 300, top + 2 * sp)
    draw_glyph(page, gr, 'restHalf', sp, 330, top + 2 * sp)
    draw_glyph(page, gr, 'flag8th', sp, 360, top - 2 * sp)
    draw_glyph(page, gr, 'flag16th', sp, 380, top + 6 * sp, flip_y=True)
    draw_glyph(page, gr, 'fClef', sp, 395, top + sp)
    Image.fromarray(page.clip(0, 255).astype(np.uint8)).save('/tmp/glyph_test.png')
    for n in GLYPHS:
        w, h = gr.size_sp(n)
        print(f'{n:16s} {w:.2f} x {h:.2f} sp  anchor-rel bbox {tuple(round(v, 2) for v in gr.anchor_offsets_sp(n))}')
