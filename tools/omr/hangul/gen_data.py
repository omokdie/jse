#!/usr/bin/env python3
"""Training / evaluation data for the Hangul lyric recogniser.

Every sample is one "token" as the OMR lyric stage sees it: a glyph rendered
from a local Korean font at high resolution (em = 64 px), geometrically
augmented, degraded like a printed page photographed or scanned at a low
resolution (em = 10..44 px), and finally cut out exactly the way
app/js/omr/hangul.js does it: a square "em-box" of side 1.25 x the line's
Hangul ink band, centred on the token's ink box horizontally and on the band
vertically, resampled to 32 x 32 and normalised to an ink map.

Modes
  train     full augmentation, all classes (Hangul / symbols / noise)
  clean     undistorted black-on-white renders (em 22..36 px), Hangul + symbols
  degraded  photo-like degradations (blur, noise, JPEG, low contrast, low
            resolution, binarisation, rotation, stroke weight, em-box jitter,
            line remnants), Hangul + symbols

Usage (normally called from train.py):
  python3 tools/omr/hangul/gen_data.py --mode train --count 200000 --seed 1 --out /tmp/jse-hangul/train.npz
"""
import argparse, io, math, os, random, sys, time
import numpy as np
import cv2
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from charset import (TYPE_INDEX, HANGUL_T, NOISE_T, DIGITS, PUNCT, LATIN, SYMBOL_VARIANTS,  # noqa: E402
                     ks_x_1001_syllables, decompose)
from core import EM_BOX, sample_embox, normalize_ink  # noqa: E402

P = 64                     # high-resolution em size (px)
CW, CH = 4 * P, 2 * P      # high-resolution canvas
YB = int(1.4 * P)          # baseline (pixel-edge coordinates)
X0 = int(1.2 * P)          # pen origin of the first glyph

NOTO = '/usr/share/fonts/opentype/noto/'
FREE = '/usr/share/fonts/truetype/freefont/'
# (name, path, face index, weight level 0..6, sampling weight)
FONTS = [
    ('sans-thin', NOTO + 'NotoSansCJK-Thin.ttc', 1, 0, 0.04),
    ('sans-light', NOTO + 'NotoSansCJK-Light.ttc', 1, 1, 0.08),
    ('sans-demilight', NOTO + 'NotoSansCJK-DemiLight.ttc', 1, 2, 0.08),
    ('sans-regular', NOTO + 'NotoSansCJK-Regular.ttc', 1, 3, 0.10),
    ('sans-medium', NOTO + 'NotoSansCJK-Medium.ttc', 1, 4, 0.08),
    ('sans-bold', NOTO + 'NotoSansCJK-Bold.ttc', 1, 5, 0.06),
    ('sans-black', NOTO + 'NotoSansCJK-Black.ttc', 1, 6, 0.03),
    ('serif-extralight', NOTO + 'NotoSerifCJK-ExtraLight.ttc', 1, 0, 0.04),
    ('serif-light', NOTO + 'NotoSerifCJK-Light.ttc', 1, 1, 0.08),
    ('serif-regular', NOTO + 'NotoSerifCJK-Regular.ttc', 1, 3, 0.10),
    ('serif-medium', NOTO + 'NotoSerifCJK-Medium.ttc', 1, 4, 0.08),
    ('serif-semibold', NOTO + 'NotoSerifCJK-SemiBold.ttc', 1, 5, 0.06),
    ('serif-bold', NOTO + 'NotoSerifCJK-Bold.ttc', 1, 5, 0.05),
    ('serif-black', NOTO + 'NotoSerifCJK-Black.ttc', 1, 6, 0.02),
    ('wqy-zenhei', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 0, 3, 0.10),
]
LATIN_FONTS = [FREE + 'FreeSans.ttf', FREE + 'FreeSerif.ttf', FREE + 'FreeSansBold.ttf', FREE + 'FreeSerifBold.ttf']
DYNAMICS_FONT = FREE + 'FreeSerifBoldItalic.ttf'
DYNAMICS = ['p', 'pp', 'ppp', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'fp', 'sf', 'fz', 'cresc.', 'dim.', 'rit.']

KS = ks_x_1001_syllables()
KS_SET = set(KS)
ALL_HANGUL = [chr(c) for c in range(0xAC00, 0xD7A4)]
NON_KS = [c for c in ALL_HANGUL if c not in KS_SET]
# syllables whose initial and vertical vowel are side by side without a final
# (they split into a left and a right part — the typical over-segmentation)
SPLITTABLE = [c for c in KS if decompose(c)[2] == 0 and decompose(c)[1] in (0, 1, 2, 3, 4, 5, 6, 7, 20)]

_font_cache = {}


def font(path, index=0, size=P):
    key = (path, index, size)
    f = _font_cache.get(key)
    if f is None:
        f = _font_cache[key] = ImageFont.truetype(path, size, index=index)
    return f


def draw_text(canvas_img, text, fnt, x, y):
    ImageDraw.Draw(canvas_img).text((x, y), text, font=fnt, fill=255, anchor='ls')


_glyph_cache = {}


def render(text, fnt, x=X0, y=YB):
    """Anti-aliased coverage mask (CH x CW, float32 0..1) of `text` drawn with
    its pen origin at (x, y) (baseline, pixel-edge coordinates). Single glyphs
    at the default origin are cached as tight uint8 crops."""
    key = (id(fnt), text) if (x == X0 and y == YB) else None
    if key is not None and key in _glyph_cache:
        crop, x0, y0 = _glyph_cache[key]
        m = np.zeros((CH, CW), np.float32)
        if crop is not None:
            m[y0:y0 + crop.shape[0], x0:x0 + crop.shape[1]] = crop * (1.0 / 255.0)
        return m
    im = Image.new('L', (CW, CH), 0)
    draw_text(im, text, fnt, x, y)
    if key is not None and len(_glyph_cache) < 60000:
        bb = im.getbbox()
        if bb:
            _glyph_cache[key] = (np.asarray(im.crop(bb), np.uint8).astype(np.float32), bb[0], bb[1])
        else:
            _glyph_cache[key] = (None, 0, 0)
    return np.asarray(im, np.float32) / 255.0


_bands = {}


def font_band(fi):
    """Median Hangul ink top / bottom (em units, relative to the baseline;
    negative = above) of font FONTS[fi], over a fixed sample of syllables."""
    if fi in _bands:
        return _bands[fi]
    name, path, idx = FONTS[fi][:3]
    f = font(path, idx)
    rng = random.Random(12345)
    tops, bots = [], []
    for ch in rng.sample(KS, 300):
        m = render(ch, f)
        ys = np.nonzero(m.max(axis=1) > 0.5)[0]
        if len(ys):
            tops.append((ys[0] - YB) / P)
            bots.append((ys[-1] + 1 - YB) / P)
    _bands[fi] = (float(np.median(tops)), float(np.median(bots)))
    return _bands[fi]


def ink_extent_x(m, thr=0.5):
    cols = np.nonzero(m.max(axis=0) > thr)[0]
    if not len(cols):
        return None
    return float(cols[0]), float(cols[-1] + 1)          # pixel-edge coordinates


FONT_FILTER = {'only': None, 'exclude': ()}     # font-generalisation experiments (--only-fonts / --exclude-fonts)


def pick_font(rng):
    ok = [i for i, f in enumerate(FONTS) if f[0] not in FONT_FILTER['exclude'] and (not FONT_FILTER['only'] or f[0] in FONT_FILTER['only'])]
    r = rng.random() * sum(FONTS[i][4] for i in ok)
    for i in ok:
        r -= FONTS[i][4]
        if r <= 0:
            return i
    return ok[-1]


# ---------------------------------------------------------------------------
# content of one sample (high resolution)
# ---------------------------------------------------------------------------
def content_hangul(rng, fi, pool):
    ch = rng.choice(pool)
    i, m, f = decompose(ch)
    return render(ch, font(FONTS[fi][1], FONTS[fi][2])), (HANGUL_T, i, m, f), ch


def content_symbol(rng, fi):
    cls = rng.choice(DIGITS + PUNCT + LATIN) if rng.random() < 0.8 else rng.choice(DIGITS + PUNCT)
    glyph = rng.choice(SYMBOL_VARIANTS.get(cls, [cls]))
    if cls in LATIN or cls in DIGITS:
        if rng.random() < 0.3:
            fnt = font(rng.choice(LATIN_FONTS), 0, int(P * rng.uniform(0.9, 1.05)))
        else:
            fnt = font(FONTS[fi][1], FONTS[fi][2])
    else:
        fnt = font(FONTS[fi][1], FONTS[fi][2])
    m = render(glyph, fnt)
    if m.max() < 0.5:                       # glyph missing in this font
        m = render(cls, font(FONTS[fi][1], FONTS[fi][2]))
    return m, (TYPE_INDEX[cls], -1, -1, -1), cls


def _line(m, x0, y0, x1, y1, th):
    cv2.line(m, (int(x0 * 16), int(y0 * 16)), (int(x1 * 16), int(y1 * 16)), 1.0, max(1, int(round(th))), cv2.LINE_AA, 4)


def content_noise(rng, fi):
    kind = rng.random()
    fnt = font(FONTS[fi][1], FONTS[fi][2])
    band = font_band(fi)
    bc = YB + (band[0] + band[1]) / 2 * P            # band centre (y)
    cx = X0 + 0.45 * P
    if kind < 0.28:                                   # left or right part of a syllable
        for _ in range(20):
            ch = rng.choice(SPLITTABLE)
            m = render(ch, fnt)
            col = m.max(axis=0) > 0.25
            xs = np.nonzero(col)[0]
            if not len(xs):
                continue
            gaps = [x for x in range(xs[0] + 2, xs[-1] - 1) if not col[x] and col[x - 1]]
            if not gaps:
                continue
            g = rng.choice(gaps)
            part = m.copy()
            if rng.random() < 0.5:
                part[:, g:] = 0
            else:
                part[:, :g] = 0
            ext = ink_extent_x(part)
            if ext and ext[1] - ext[0] < 0.62 * P:
                return part, (NOISE_T, -1, -1, -1), 'part'
        return render(rng.choice(SPLITTABLE)[0], fnt) * 0, (NOISE_T, -1, -1, -1), 'empty'
    if kind < 0.45:                                   # two syllables run together
        a, b = rng.choice(KS), rng.choice(KS)
        adv = fnt.getlength(a)
        im = Image.new('L', (CW, CH), 0)
        draw_text(im, a, fnt, X0 - 0.4 * P, YB)
        draw_text(im, b, fnt, X0 - 0.4 * P + adv * rng.uniform(0.8, 1.0), YB)
        return np.asarray(im, np.float32) / 255.0, (NOISE_T, -1, -1, -1), 'merged'
    m = np.zeros((CH, CW), np.float32)
    if kind < 0.62:                                   # note head (+ stem / ledger line)
        ax, ay = 0.33 * P * rng.uniform(0.8, 1.3), 0.23 * P * rng.uniform(0.8, 1.3)
        hy = bc + rng.uniform(-0.5, 0.5) * P
        cv2.ellipse(m, (int(cx * 16), int(hy * 16)), (int(ax * 16), int(ay * 16)), rng.uniform(-30, -10), 0, 360, 1.0, -1, cv2.LINE_AA, 4)
        if rng.random() < 0.3:                        # hollow
            cv2.ellipse(m, (int(cx * 16), int(hy * 16)), (int(ax * 0.55 * 16), int(ay * 0.45 * 16)), rng.uniform(-40, -20), 0, 360, 0.0, -1, cv2.LINE_AA, 4)
        if rng.random() < 0.6:
            sx = cx + ax * (1 if rng.random() < 0.5 else -1) * 0.92
            _line(m, sx, hy, sx, hy + rng.choice([-1, 1]) * rng.uniform(1.0, 2.5) * P, 0.05 * P)
        if rng.random() < 0.3:
            _line(m, cx - ax * 1.5, hy, cx + ax * 1.5, hy, 0.05 * P)
        return m, (NOISE_T, -1, -1, -1), 'head'
    if kind < 0.70:                                   # beam piece
        y = bc + rng.uniform(-0.5, 0.5) * P
        sl = rng.uniform(-0.25, 0.25)
        pts = np.array([[cx - P, y - sl * P], [cx + P, y + sl * P], [cx + P, y + sl * P + 0.25 * P], [cx - P, y - sl * P + 0.25 * P]])
        cv2.fillPoly(m, [np.int32(pts * 16)], 1.0, cv2.LINE_AA, 4)
        return m, (NOISE_T, -1, -1, -1), 'beam'
    if kind < 0.80:                                   # slur / tie / hairpin
        if rng.random() < 0.6:
            w = rng.uniform(1.0, 3.0) * P
            sag = rng.uniform(0.15, 0.5) * P * rng.choice([-1, 1])
            th = rng.uniform(0.03, 0.08) * P
            xs = np.linspace(cx - w / 2 + rng.uniform(-0.5, 0.5) * P, cx + w / 2, 40)
            t = np.linspace(0, 1, 40)
            ys = bc + rng.uniform(-0.4, 0.4) * P + sag * 4 * t * (1 - t)
            for k in range(39):
                _line(m, xs[k], ys[k], xs[k + 1], ys[k + 1], th * (0.5 + 2 * t[k] * (1 - t[k])))
        else:
            y = bc + rng.uniform(-0.3, 0.3) * P
            x_tip = cx + rng.uniform(-1.5, 0.5) * P
            span = rng.uniform(0.15, 0.4) * P
            for sgn in (-1, 1):
                _line(m, x_tip, y, x_tip + 2.5 * P, y + sgn * span, 0.04 * P)
        return m, (NOISE_T, -1, -1, -1), 'arc'
    if kind < 0.90:                                   # dynamics / Italian text marks
        txt = rng.choice(DYNAMICS)
        f2 = font(DYNAMICS_FONT, 0, int(P * rng.uniform(0.8, 1.2)))
        im = Image.new('L', (CW, CH), 0)
        draw_text(im, txt, f2, X0 + rng.uniform(-0.3, 0.2) * P, YB + rng.uniform(-0.1, 0.1) * P)
        return np.asarray(im, np.float32) / 255.0, (NOISE_T, -1, -1, -1), 'dyn'
    if kind < 0.97:                                   # scribble
        n = rng.randint(3, 6)
        pts = [(cx + rng.uniform(-0.5, 0.5) * P, bc + rng.uniform(-0.5, 0.5) * P) for _ in range(n)]
        th = rng.uniform(0.04, 0.12) * P
        for a, b in zip(pts, pts[1:]):
            _line(m, a[0], a[1], b[0], b[1], th)
        return m, (NOISE_T, -1, -1, -1), 'scribble'
    for _ in range(rng.randint(0, 4)):                # specks
        cv2.circle(m, (int((cx + rng.uniform(-0.5, 0.5) * P) * 16), int((bc + rng.uniform(-0.5, 0.5) * P) * 16)),
                   int(rng.uniform(0.02, 0.07) * P * 16), 1.0, -1, cv2.LINE_AA, 4)
    return m, (NOISE_T, -1, -1, -1), 'speck'


# ---------------------------------------------------------------------------
# augmentation + em-box crop
# ---------------------------------------------------------------------------
def window(m, cx, cy, half=P):
    """Square (2*half)^2 window of the canvas centred near (cx, cy); returns
    the window and its origin (canvas pixel-edge coordinates)."""
    x0, y0 = int(round(cx - half)), int(round(cy - half))
    out = np.zeros((2 * half, 2 * half), np.float32)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(CW, x0 + 2 * half), min(CH, y0 + 2 * half)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = m[sy0:sy1, sx0:sx1]
    return out, x0, y0


def elastic(m, rng, amp):
    """Smooth random displacement field (font-design variation)."""
    n = m.shape[0]
    g = 4
    dx = cv2.resize((np.random.default_rng(rng.randrange(1 << 30)).standard_normal((g, g)) * amp).astype(np.float32), (n, n), interpolation=cv2.INTER_CUBIC)
    dy = cv2.resize((np.random.default_rng(rng.randrange(1 << 30)).standard_normal((g, g)) * amp).astype(np.float32), (n, n), interpolation=cv2.INTER_CUBIC)
    xs, ys = np.meshgrid(np.arange(n, dtype=np.float32), np.arange(n, dtype=np.float32))
    return cv2.remap(m, xs + dx, ys + dy, cv2.INTER_LINEAR, borderValue=0)


def make_sample(rng, mode):
    fi = pick_font(rng)
    band = font_band(fi)
    r = rng.random()
    if mode == 'train':
        if r < 0.74:
            m, lab, ch = content_hangul(rng, fi, KS)
        elif r < 0.82:
            m, lab, ch = content_hangul(rng, fi, NON_KS)
        elif r < 0.91:
            m, lab, ch = content_symbol(rng, fi)
        else:
            m, lab, ch = content_noise(rng, fi)
    else:
        if r < 0.85:
            m, lab, ch = content_hangul(rng, fi, KS)
        else:
            m, lab, ch = content_symbol(rng, fi)
    aug = mode != 'clean'
    band_top = YB + band[0] * P
    band_bot = YB + band[1] * P
    ext = ink_extent_x(m)
    cx = (ext[0] + ext[1]) / 2 if ext else X0 + 0.45 * P
    cy = (band_top + band_bot) / 2
    # work on a 2P x 2P window around the token from here on
    m, wx0, wy0 = window(m, cx, cy)
    cx -= wx0
    cy -= wy0
    band_top -= wy0
    band_bot -= wy0
    n = m.shape[0]
    if aug:
        # geometric: rotation, shear, horizontal scale about the token centre
        th = math.radians(max(-3.5, min(3.5, rng.gauss(0, 1.2))))
        sh = max(-0.18, min(0.18, rng.gauss(0, 0.06)))
        sx = math.exp(max(-0.15, min(0.15, rng.gauss(0, 0.06))))
        c, s = math.cos(th), math.sin(th)
        A = np.array([[c, -s], [s, c]]) @ np.array([[1, sh], [0, 1]]) @ np.array([[sx, 0], [0, 1]])
        t = np.array([cx, cy]) - A @ np.array([cx, cy])
        M = np.hstack([A, t[:, None]]).astype(np.float32)
        m = cv2.warpAffine(m, M, (n, n), flags=cv2.INTER_LINEAR, borderValue=0)
        if mode == 'train' and rng.random() < 0.35:
            m = elastic(m, rng, rng.uniform(0.5, 1.6))
        # stroke weight
        lvl = FONTS[fi][3]
        rw = rng.random()
        k3 = np.ones((3, 3), np.uint8)
        if rw < 0.25 and lvl <= 5:
            d = cv2.dilate(m, k3, iterations=2 if rng.random() < 0.3 else 1)
            a = rng.uniform(0.3, 1.0)
            m = (1 - a) * m + a * d
        elif rw < 0.45 and lvl >= 2:
            e = cv2.erode(m, k3, iterations=2 if (lvl >= 4 and rng.random() < 0.3) else 1)
            a = rng.uniform(0.3, 1.0)
            m = (1 - a) * m + a * e
        # token centre after warping (the inference side centres on the ink box)
        ext2 = ink_extent_x(m)
        if ext2 and lab[0] != NOISE_T:
            cx = (ext2[0] + ext2[1]) / 2
        # distractors: line remnants (underline, ledger, extender), specks
        if rng.random() < 0.12:
            y = (band_bot - 0.02 * P) if rng.random() < 0.5 else cy + rng.uniform(-0.65, 0.65) * P
            xa = cx + rng.uniform(-1.2, 0.3) * P
            _line(m, xa, y, xa + rng.uniform(0.3, 1.6) * P, y + rng.uniform(-0.05, 0.05) * P, rng.uniform(0.03, 0.08) * P)
        if rng.random() < 0.10:
            for _ in range(rng.randint(1, 3)):
                cv2.circle(m, (int((cx + rng.uniform(-0.6, 0.6) * P) * 16), int((cy + rng.uniform(-0.6, 0.6) * P) * 16)),
                           max(1, int(rng.uniform(0.015, 0.05) * P * 16)), 1.0, -1, cv2.LINE_AA, 4)
        m = np.clip(m, 0, 1)
    # observed resolution
    if mode == 'train':
        E = math.exp(rng.uniform(math.log(10), math.log(48)))
        if rng.random() < 0.35:
            E = rng.uniform(14, 28)                    # most common lyric sizes
    elif mode == 'degraded':
        E = math.exp(rng.uniform(math.log(12), math.log(40)))
    else:
        E = rng.uniform(22, 36)
    s = E / P
    No = max(8, int(round(n * s)))
    so = No / n
    mo = cv2.resize(m, (No, No), interpolation=cv2.INTER_AREA)
    if aug:
        paper = rng.uniform(165, 250) if rng.random() < 0.8 else 255.0
        ink = rng.uniform(0, 110) if rng.random() < 0.8 else 0.0
        if paper - ink < 70:
            ink = paper - 70
        g = paper - (paper - ink) * mo
        if rng.random() < 0.3:                         # uneven light across the crop
            gx, gy = rng.uniform(-12, 12), rng.uniform(-12, 12)
            yy, xx = np.mgrid[0:No, 0:No]
            g = g + gx * (xx / No - 0.5) * 2 + gy * (yy / No - 0.5) * 2
        if rng.random() < 0.8:                         # optical blur, relative to the glyph size
            sig = min(1.6, rng.uniform(0.15, (0.055 if mode == 'train' else 0.045) * E))
            g = cv2.GaussianBlur(g, (0, 0), sig)
        if rng.random() < 0.7:
            g = g + np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(1, 10 if mode == 'train' else 8), g.shape)
        g = np.clip(g, 0, 255)
        if rng.random() < 0.5:
            ok, buf = cv2.imencode('.jpg', g.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, rng.randint(25, 90)])
            g = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE).astype(np.float32)
        if rng.random() < 0.12:
            thr = (paper + ink) / 2 + rng.uniform(-0.15, 0.15) * (paper - ink)
            g = np.where(g < thr, ink, paper).astype(np.float32)
    else:
        g = 255.0 - 255.0 * mo
    S = EM_BOX * (band_bot - band_top)
    if aug:
        cx += rng.uniform(-0.04, 0.04) * S
        cy += rng.uniform(-0.05, 0.05) * S
        S *= math.exp(rng.uniform(-0.08, 0.08))
    # high-res pixel-edge coordinates -> observed pixel-centre coordinates
    crop = sample_embox(g.astype(np.float64), cx * so - 0.5, cy * so - 0.5, S * so)
    inkmap = normalize_ink(crop)
    return np.round(inkmap * 255).astype(np.uint8), lab, fi, ch


def generate(mode, count, seed, quiet=False):
    rng = random.Random(seed)
    X = np.zeros((count, 32, 32), np.uint8)
    L = np.full((count, 4), -1, np.int16)
    Fo = np.zeros(count, np.int8)
    C = np.zeros(count, np.int32)
    t0 = time.time()
    for n in range(count):
        x, lab, fi, ch = make_sample(rng, mode)
        X[n] = x
        L[n] = lab
        Fo[n] = fi
        C[n] = ord(ch) if len(ch) == 1 else 0
        if not quiet and n and n % 20000 == 0:
            print(f'  {mode} seed {seed}: {n}/{count} ({time.time() - t0:.0f}s)', flush=True)
    return X, L, Fo, C


def _worker(args):
    mode, count, seed = args
    return generate(mode, count, seed, quiet=True)


def generate_parallel(mode, count, seed, procs=2, chunk=8000):
    from multiprocessing import Pool
    jobs = []
    left, k = count, 0
    while left > 0:
        n = min(chunk, left)
        jobs.append((mode, n, seed * 100003 + k))
        left -= n
        k += 1
    if procs <= 1:
        parts = [_worker(j) for j in jobs]
    else:
        with Pool(procs) as pool:
            parts = pool.map(_worker, jobs)
    return tuple(np.concatenate([p[i] for p in parts]) for i in range(4))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', default='train', choices=['train', 'clean', 'degraded'])
    ap.add_argument('--count', type=int, default=20000)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--procs', type=int, default=2)
    ap.add_argument('--out', required=True)
    ap.add_argument('--preview', default=None, help='write a PNG mosaic of the first 256 samples')
    ap.add_argument('--only-fonts', default=None, help='comma-separated font names (FONTS) to use exclusively')
    ap.add_argument('--exclude-fonts', default=None, help='comma-separated font names (FONTS) to leave out')
    args = ap.parse_args()
    if args.only_fonts:
        FONT_FILTER['only'] = tuple(args.only_fonts.split(','))
    if args.exclude_fonts:
        FONT_FILTER['exclude'] = tuple(args.exclude_fonts.split(','))
    t0 = time.time()
    X, L, Fo, C = generate_parallel(args.mode, args.count, args.seed, args.procs)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    np.savez(args.out, X=X, L=L, F=Fo, C=C)
    print(f'{args.mode}: {len(X)} samples in {time.time() - t0:.0f}s -> {args.out}')
    if args.preview:
        n = min(256, len(X))
        grid = np.full((16 * 34, 16 * 34), 128, np.uint8)
        for i in range(n):
            r, c = divmod(i, 16)
            grid[r * 34 + 1:r * 34 + 33, c * 34 + 1:c * 34 + 33] = 255 - X[i]
        cv2.imwrite(args.preview, grid)


if __name__ == '__main__':
    main()
