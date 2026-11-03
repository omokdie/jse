#!/usr/bin/env python3
"""Train the note-head classifier (none / filled / half / whole) on patches
extracted by extract_heads.mjs and export it to app/js/omr/models/heads.js.

  node tools/omr/extract_heads.mjs --dir /tmp/omr_train/train_photo,/tmp/omr_train/train_clean --out /tmp/heads_train
  python3 tools/omr/train_heads.py --data /tmp/heads_train [--epochs 30]
"""
import argparse, json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mlp import train_mlp, predict, quantize, export_js  # noqa: E402

P = 24
REC = 1 + 16 + P * P


def load(base):
    raw = np.fromfile(base + '.bin', np.uint8)
    n = len(raw) // REC
    raw = raw[:n * REC].reshape(n, REC)
    y = raw[:, 0].astype(np.int64)
    feat = raw[:, 1:17].copy().view(np.float32).reshape(n, 4)
    patch = (raw[:, 17:].astype(np.float32) - 20.0) / 180.0
    stats = json.load(open(base + '.json'))
    img_of = np.concatenate([np.full(r['kept'], i) for i, r in enumerate(stats['perImage'])]) if stats['perImage'] else np.zeros(n)
    return np.concatenate([patch, feat], axis=1).astype(np.float32), y, img_of[:n]


def augment(xb, rng):
    xb = xb.copy()
    n = len(xb)
    pt = xb[:, :P * P].reshape(n, P, P)
    dx = rng.integers(-1, 2, n); dy = rng.integers(-1, 2, n)
    for sx in (-1, 1):
        sel = dx == sx
        if sel.any():
            pt[sel] = np.roll(pt[sel], sx, axis=2)
            pt[sel, :, 0 if sx == 1 else -1] = 0
    for sy in (-1, 1):
        sel = dy == sy
        if sel.any():
            pt[sel] = np.roll(pt[sel], sy, axis=1)
            pt[sel, 0 if sy == 1 else -1, :] = 0
    pt *= rng.uniform(0.8, 1.2, (n, 1, 1)).astype(np.float32)
    pt += rng.normal(0, 0.03, pt.shape).astype(np.float32)
    xb[:, :P * P] = pt.reshape(n, P * P)
    return xb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='/tmp/heads_train')
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--hidden', default='64,32')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', 'app', 'js', 'omr', 'models', 'heads.js'))
    args = ap.parse_args()
    X, y, img = load(args.data)
    print('samples', len(y), 'labels', np.bincount(y, minlength=4))
    n_img = int(img.max()) + 1
    val_imgs = set(range(0, n_img, 10))                     # every 10th image for validation
    vm = np.array([i in val_imgs for i in img])
    Xt, yt, Xv, yv = X[~vm], y[~vm], X[vm], y[vm]
    hidden = tuple(int(v) for v in args.hidden.split(','))
    model = train_mlp(Xt, yt, Xv, yv, hidden=hidden, n_classes=4, epochs=args.epochs, augment=augment)
    _, deq = quantize(model)
    for nm, mdl in (('float', model), ('int8', deq)):
        pv = predict(mdl, Xv).argmax(1)
        cm = np.zeros((4, 4), int)
        for a, b in zip(yv, pv):
            cm[a, b] += 1
        print(nm, 'val acc', (pv == yv).mean().round(4), 'confusion (rows = truth none/filled/half/whole):')
        print(cm)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    meta = {'classes': ['none', 'filled', 'half', 'whole'], 'patch': P, 'features': ['onLine', 'above', 'below', 'R'],
            'trainedOn': int(len(yt)), 'valAcc': float((predict(deq, Xv).argmax(1) == yv).mean())}
    size = export_js(model, args.out, 'heads', meta)
    print('wrote', os.path.normpath(args.out), size, 'bytes')


if __name__ == '__main__':
    main()
