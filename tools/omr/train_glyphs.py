#!/usr/bin/env python3
"""Train the component (glyph) classifier on samples from extract_glyphs.mjs
and export it to app/js/omr/models/glyphs.js.

  node tools/omr/extract_glyphs.mjs --dir /tmp/omr_train/train_photo,/tmp/omr_train/train_clean --out /tmp/glyphs_train
  python3 tools/omr/train_glyphs.py --data /tmp/glyphs_train
"""
import argparse, json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mlp import train_mlp, predict, quantize, export_js  # noqa: E402

GW, GH, NG = 16, 24, 8
NP = GW * GH
REC = 1 + 4 * NG + NP
CLASSES = ['none', 'sharp', 'flat', 'natural', 'restWhole', 'restHalf', 'restQuarter', 'rest8th', 'rest16th', 'rest32nd',
           'gClef', 'fClef', 'cClef', 'digit0', 'digit1', 'digit2', 'digit3', 'digit4', 'digit5', 'digit6', 'digit7', 'digit8', 'digit9',
           'common', 'cut', 'dot']


def load(bases):
    """One or more extraction outputs (comma-separated bases), concatenated;
    image ids stay distinct so the per-image validation split still works."""
    parts = [load_one(b) for b in bases.split(',')]
    off, Xs, ys, imgs = 0, [], [], []
    for X, y, img in parts:
        Xs.append(X); ys.append(y); imgs.append(img + off); off += int(img.max()) + 1 if len(img) else 0
    return np.concatenate(Xs), np.concatenate(ys), np.concatenate(imgs)


def load_one(base):
    raw = np.fromfile(base + '.bin', np.uint8)
    n = len(raw) // REC
    raw = raw[:n * REC].reshape(n, REC)
    y = raw[:, 0].astype(np.int64)
    geom = raw[:, 1:1 + 4 * NG].copy().view(np.float32).reshape(n, NG)
    patch = (raw[:, 1 + 4 * NG:].astype(np.float32) - 20.0) / 180.0
    stats = json.load(open(base + '.json'))
    img = np.concatenate([np.full(r['kept'], i) for i, r in enumerate(stats['perImage'])])[:n]
    return np.concatenate([patch, geom], axis=1).astype(np.float32), y, img


def augment(xb, rng):
    xb = xb.copy()
    n = len(xb)
    pt = xb[:, :NP]
    pt *= rng.uniform(0.8, 1.2, (n, 1)).astype(np.float32)
    pt += rng.normal(0, 0.03, pt.shape).astype(np.float32)
    g = xb[:, NP:]
    g[:, :2] *= rng.uniform(0.94, 1.06, (n, 2)).astype(np.float32)        # size jitter
    g[:, 3:6] += rng.normal(0, 0.02, (n, 1)).astype(np.float32)          # position jitter
    return xb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/tmp/glyphs_train')
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--hidden', default='96,48')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'app', 'js', 'omr', 'models', 'glyphs.js'))
    args = ap.parse_args()
    X, y, img = load(args.data)
    k = len(CLASSES)
    print('samples', len(y), 'per class', dict(zip(CLASSES, np.bincount(y, minlength=k).tolist())))
    vm = (img % 10) == 0
    Xt, yt, Xv, yv = X[~vm], y[~vm], X[vm], y[vm]
    hidden = tuple(int(v) for v in args.hidden.split(','))
    model = train_mlp(Xt, yt, Xv, yv, hidden=hidden, n_classes=k, epochs=args.epochs, augment=augment, lr=2e-3)
    _, deq = quantize(model)
    pv = predict(deq, Xv).argmax(1)
    print('int8 val acc', round(float((pv == yv).mean()), 4))
    for c in range(k):
        sel = yv == c
        if sel.any():
            wrong = np.bincount(pv[sel], minlength=k)
            top = [f'{CLASSES[j]}:{wrong[j]}' for j in np.argsort(-wrong)[:3] if wrong[j] and j != c]
            print(f'  {CLASSES[c]:12s} n={sel.sum():5d} recall {float((pv[sel] == c).mean()):.3f}  confused with {" ".join(top)}')
    meta = {'classes': CLASSES, 'gw': GW, 'gh': GH, 'trainedOn': int(len(yt)), 'valAcc': float((pv == yv).mean())}
    size = export_js(model, args.out, 'glyphs', meta)
    print('wrote', os.path.normpath(args.out), size, 'bytes')


if __name__ == '__main__':
    main()
