"""Shared numerics of the Hangul recogniser: em-box sampling, ink
normalisation and feature extraction. These functions are exact ports of the
inference code in app/js/omr/hangul.js — keep both in sync (the test
tools/tests/hangul.test.js compares them on fixtures written by
`python3 tools/omr/hangul/train.py --fixtures`).

Coordinates use the "pixel centre at integer" convention of omr.js: pixel
(x, y) of an image is the sample at the continuous point (x, y).
"""
import math
import numpy as np

CROP = 32            # model input: CROP x CROP ink map of the em-box
EM_BOX = 1.25        # em-box side = EM_BOX x height of the line's Hangul ink band
PAPER_PCT = 0.75     # paper level = this quantile of the crop
INK_PCT = 0.02       # ink level   = this quantile of the crop
MIN_CONTRAST = 40.0
FEAT_DIM = 8 * 8 * 8 + 16 * 16


def supersample_factor(s_orig):
    """k x k samples per output pixel so that samples are <= ~1 source px apart."""
    return int(min(4, max(1, math.ceil(s_orig / CROP - 0.01))))


def bilinear(img, xs, ys):
    """img: 2-D float64 array; xs, ys: arrays of continuous coordinates.
    Points whose 2x2 neighbourhood leaves the image read as paper (255)."""
    H, W = img.shape
    x0 = np.floor(xs).astype(np.int64)
    y0 = np.floor(ys).astype(np.int64)
    fx = xs - x0
    fy = ys - y0
    ok = (x0 >= 0) & (y0 >= 0) & (x0 + 1 < W) & (y0 + 1 < H)
    x0c = np.clip(x0, 0, W - 2)
    y0c = np.clip(y0, 0, H - 2)
    a = img[y0c, x0c]
    b = img[y0c, x0c + 1]
    c = img[y0c + 1, x0c]
    d = img[y0c + 1, x0c + 1]
    v = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return np.where(ok, v, 255.0)


def sample_embox(img, cx, cy, S, k=None, affine=None):
    """CROP x CROP grey crop of the square [cx-S/2, cx+S/2] x [cy-S/2, cy+S/2].
    `affine` (2x3) maps crop-space points to image coordinates (identity if
    None); k = supersampling factor (default from S)."""
    if k is None:
        k = supersample_factor(S if affine is None else S * math.hypot(affine[0][0], affine[1][0]))
    n = CROP
    sub = (np.arange(k, dtype=np.float64) + 0.5) / k
    u = np.arange(n, dtype=np.float64)
    # offsets along one axis: ((u + sub) / n - 0.5) * S, ordered [u][a]
    off = (((u[:, None] + sub[None, :]) / n) - 0.5) * S          # (n, k)
    fx = np.broadcast_to(off[None, None, :, :], (n, k, n, k))     # [v][b][u][a]
    fy = np.broadcast_to(off[:, :, None, None], (n, k, n, k))
    px = cx + fx
    py = cy + fy
    if affine is not None:
        A = affine
        px, py = A[0, 0] * px + A[0, 1] * py + A[0, 2], A[1, 0] * px + A[1, 1] * py + A[1, 2]
    v = bilinear(img, px.reshape(-1), py.reshape(-1)).reshape(n, k, n, k)
    # sum in the same order as the JS loop: for b, for a
    acc = np.zeros((n, n), np.float64)
    for b in range(k):
        for a in range(k):
            acc += v[:, b, :, a]
    return acc / (k * k)


def quantile_sorted(vals, q):
    s = np.sort(vals)
    return s[int(math.floor(q * (len(s) - 1)))]


def normalize_ink(crop, mask=None):
    """Grey crop -> ink map in [0,1] quantised to 1/255 steps. `mask` marks
    pixels to ignore (neighbouring tokens); they become paper."""
    vals = crop.reshape(-1) if mask is None else crop.reshape(-1)[~mask.reshape(-1)]
    if len(vals) < 16:
        vals = crop.reshape(-1)
    paper = quantile_sorted(vals, PAPER_PCT)
    ink = quantile_sorted(vals, INK_PCT)
    contrast = max(paper - ink, MIN_CONTRAST)
    m = np.clip((paper - crop) / contrast, 0.0, 1.0)
    if mask is not None:
        m = np.where(mask, 0.0, m)
    return np.floor(m * 255.0 + 0.5) / 255.0      # same rounding as Math.floor(x + 0.5) in JS


def features(ink):
    """ink: (N, 32, 32) float64 in [0,1] -> (N, FEAT_DIM) float64.
    8-direction gradient maps pooled on an 8x8 grid (sqrt) + 16x16 ink."""
    ink = np.asarray(ink, np.float64)
    N = ink.shape[0]
    p = np.pad(ink, ((0, 0), (1, 1), (1, 1)))
    gx = (p[:, :-2, 2:] + 2 * p[:, 1:-1, 2:] + p[:, 2:, 2:]) - (p[:, :-2, :-2] + 2 * p[:, 1:-1, :-2] + p[:, 2:, :-2])
    gy = (p[:, 2:, :-2] + 2 * p[:, 2:, 1:-1] + p[:, 2:, 2:]) - (p[:, :-2, :-2] + 2 * p[:, :-2, 1:-1] + p[:, :-2, 2:])
    mag = np.sqrt(gx * gx + gy * gy)
    ang = np.arctan2(gy, gx)
    t = np.mod(ang, 2 * math.pi) / (math.pi / 4)
    k0 = np.floor(t)
    f = t - k0
    k0 = k0.astype(np.int64) % 8
    k1 = (k0 + 1) % 8
    w0 = (1 - f) * mag
    w1 = f * mag
    planes = np.empty((N, 8, CROP, CROP), np.float64)
    for d in range(8):
        planes[:, d] = np.where(k0 == d, w0, 0.0) + np.where(k1 == d, w1, 0.0)
    pooled = planes.reshape(N, 8, 8, 4, 8, 4).sum(axis=(3, 5))            # (N, 8, 8, 8)
    q = np.pad(pooled, ((0, 0), (0, 0), (1, 1), (0, 0)))
    pooled = q[:, :, :-2] + 2 * q[:, :, 1:-1] + q[:, :, 2:]
    q = np.pad(pooled, ((0, 0), (0, 0), (0, 0), (1, 1)))
    pooled = (q[:, :, :, :-2] + 2 * q[:, :, :, 1:-1] + q[:, :, :, 2:]) / 16.0
    dirf = np.sqrt(pooled).reshape(N, 512)
    inten = ink.reshape(N, 16, 2, 16, 2).mean(axis=(2, 4)).reshape(N, 256)
    return np.concatenate([dirf, inten], axis=1)
