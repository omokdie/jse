#!/usr/bin/env python3
"""Photo-like variants of the synthetic corpus (OpenCV).

For every corpus/base/<name>.png this writes corpus/aug/<name>_<variant>.(jpg|png)
plus a ground-truth JSON whose geometry (staff lines, measure/staff/event boxes)
went through the same geometric transform. Variants:

  rot    : rotation ±3°, light blur, JPEG q=60
  persp  : mild perspective + illumination gradient + sensor noise
  photo  : blur, vignette, noise, slight rotation, JPEG q=60 (typical phone shot)
  curve  : page curvature (sinusoidal), slight rotation, uneven light, JPEG

Usage: python3 tools/omr/augment.py [--corpus tools/omr/corpus] [--seed 7] [--per-image 2]
"""
import argparse, glob, json, math, os, random
import cv2
import numpy as np

VARIANTS = ['rot', 'persp', 'photo', 'curve']


def paper_fill(img):
    border = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    return int(np.median(border))


def make_transform(kind, W, H, sp, rng):
    """Returns (homography 3x3, curvature amplitude px, angle deg)."""
    angle = 0.0
    if kind == 'rot':
        angle = rng.uniform(1.0, 3.0) * rng.choice([-1, 1])
    elif kind in ('photo', 'curve'):
        angle = rng.uniform(-1.2, 1.2)
    elif kind == 'persp':
        angle = rng.uniform(-0.8, 0.8)
    R = cv2.getRotationMatrix2D((W / 2, H / 2), angle, 1.0)
    Hm = np.vstack([R, [0, 0, 1]])
    if kind == 'persp':
        d = rng.uniform(0.01, 0.025)
        src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
        dx, dy = d * W, d * H
        dst = np.float32([[rng.uniform(0, dx), rng.uniform(0, dy)], [W - rng.uniform(0, dx), rng.uniform(0, dy)],
                          [W - rng.uniform(0, dx), H - rng.uniform(0, dy)], [rng.uniform(0, dx), H - rng.uniform(0, dy)]])
        P = cv2.getPerspectiveTransform(src, dst)
        Hm = P @ Hm
    curve = rng.uniform(0.25, 0.6) * sp if kind == 'curve' else 0.0
    return Hm, curve, angle


def apply_geometry(img, Hm, curve, fill):
    H, W = img.shape[:2]
    out = img
    if curve:
        xs, ys = np.meshgrid(np.arange(W, dtype=np.float32), np.arange(H, dtype=np.float32))
        src_y = ys - curve * np.sin(np.pi * xs / W).astype(np.float32)
        out = cv2.remap(out, xs, src_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=fill)
    out = cv2.warpPerspective(out, Hm, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=fill)
    return out


def map_points(pts, Hm, curve, W):
    pts = np.asarray(pts, np.float64).reshape(-1, 2)
    if curve:
        pts = pts.copy()
        pts[:, 1] += curve * np.sin(np.pi * pts[:, 0] / W)
    p = cv2.perspectiveTransform(pts.reshape(-1, 1, 2), Hm).reshape(-1, 2)
    return p


def map_bbox(b, Hm, curve, W):
    x, y, w, h = b
    p = map_points([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], Hm, curve, W)
    x0, y0 = p.min(axis=0); x1, y1 = p.max(axis=0)
    return [float(x0), float(y0), float(x1 - x0), float(y1 - y0)]


def photometric(img, kind, sp, rng):
    H, W = img.shape
    f = img.astype(np.float32)
    if kind in ('photo', 'rot', 'curve'):
        sigma = rng.uniform(0.5, 1.1) * max(0.6, sp / 10)
        f = cv2.GaussianBlur(f, (0, 0), sigma)
    if kind in ('persp', 'photo', 'curve'):
        # illumination: linear gradient + vignette
        ys, xs = np.mgrid[0:H, 0:W].astype(np.float32)
        gx, gy = rng.uniform(-0.35, 0.35), rng.uniform(-0.35, 0.35)
        grad = 1.0 + gx * (xs / W - 0.5) + gy * (ys / H - 0.5)
        r = np.sqrt(((xs - W / 2) / W) ** 2 + ((ys - H / 2) / H) ** 2)
        vig = 1.0 - rng.uniform(0.15, 0.45) * (r / r.max()) ** 2
        f = f * grad * vig * rng.uniform(0.85, 1.0)
    if kind in ('persp', 'photo', 'curve'):
        f += np.random.default_rng(rng.randrange(1 << 30)).normal(0, rng.uniform(2, 7), f.shape).astype(np.float32)
    return np.clip(f, 0, 255).astype(np.uint8)


def transform_gt(gt, Hm, curve, W):
    g = json.loads(json.dumps(gt))
    for sysd in g['systems']:
        for st in sysd['staves']:
            st['lines'] = [[list(map(float, p)) for p in map_points(line, Hm, curve, W)] for line in st['lines']]
            st['bbox'] = map_bbox(st['bbox'], Hm, curve, W)
    for m in g['measures']:
        m['bbox'] = map_bbox(m['bbox'], Hm, curve, W)
        for evs in m['staves']:
            for ev in evs:
                if 'bbox' in ev and ev['bbox']:
                    ev['bbox'] = map_bbox(ev['bbox'], Hm, curve, W)
                    ev['x'] = ev['bbox'][0] + ev['bbox'][2] / 2
                for ly in ev.get('lyrics', []):          # Korean lyric ground truth (gen_lyrics_corpus.py)
                    ly['bbox'] = map_bbox(ly['bbox'], Hm, curve, W)
    return g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--corpus', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'corpus'))
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--per-image', type=int, default=2)
    args = ap.parse_args()
    base = sorted(glob.glob(os.path.join(args.corpus, 'base', '*.png')))
    out_dir = os.path.join(args.corpus, 'aug')
    os.makedirs(out_dir, exist_ok=True)
    for i, png in enumerate(base):
        rng = random.Random(args.seed * 7919 + i)
        gt = json.load(open(png[:-4] + '.json'))
        img = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
        H, W = img.shape
        sp = gt['staffSpace']
        kinds = rng.sample(VARIANTS, k=min(args.per_image, len(VARIANTS)))
        for kind in kinds:
            Hm, curve, angle = make_transform(kind, W, H, sp, rng)
            fill = paper_fill(img)
            out = apply_geometry(img, Hm, curve, fill)
            out = photometric(out, kind, sp, rng)
            name = os.path.basename(png)[:-4] + '_' + kind
            use_jpeg = kind in ('rot', 'photo', 'curve')
            path = os.path.join(out_dir, name + ('.jpg' if use_jpeg else '.png'))
            if use_jpeg:
                cv2.imwrite(path, out, [cv2.IMWRITE_JPEG_QUALITY, 60])
            else:
                cv2.imwrite(path, out)
            g = transform_gt(gt, Hm, curve, W)
            g['image'] = os.path.basename(path)
            g['augment'] = {'kind': kind, 'angle': angle, 'curve': curve}
            json.dump(g, open(os.path.join(out_dir, name + '.json'), 'w'))
            print(name, f'angle={angle:.2f} curve={curve:.1f}px')


if __name__ == '__main__':
    main()
