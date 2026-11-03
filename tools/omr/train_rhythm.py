#!/usr/bin/env python3
"""Train the beam / flag counter (none / 8th / 16th / 32nd+) on stem samples
from extract_glyphs.mjs --rhythm-out and export app/js/omr/models/rhythm.js;
with --kind bars the barline verifier (models/bars.js) from --bars-out samples.

  node tools/omr/extract_glyphs.mjs --dir <photos> --out /tmp/g --rhythm-out /tmp/r --bars-out /tmp/b
  python3 tools/omr/train_rhythm.py --data /tmp/r[,/tmp/r2...]
  python3 tools/omr/train_rhythm.py --kind bars --data /tmp/b[,...]
"""
import argparse, json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from mlp import train_mlp, predict, quantize, export_js  # noqa: E402

KINDS = {
    'rhythm': dict(rw=20, rh=28, ng=8, classes=['none', 'eighth', '16th', '32nd'], rule=(5, 6)),
    'bars': dict(rw=16, rh=35, ng=10, classes=['no', 'barline'], rule=None),
}
RW, RH, NG = 20, 28, 8
NP = RW * RH
REC = 1 + 4 * NG + NP
CLASSES = KINDS['rhythm']['classes']


def set_kind(kind):
    global RW, RH, NG, NP, REC, CLASSES
    k = KINDS[kind]
    RW, RH, NG, CLASSES = k['rw'], k['rh'], k['ng'], k['classes']
    NP = RW * RH
    REC = 1 + 4 * NG + NP


def load_one(base):
    raw = np.fromfile(base + '.bin', np.uint8)
    n = len(raw) // REC
    raw = raw[:n * REC].reshape(n, REC)
    y = raw[:, 0].astype(np.int64)
    geom = raw[:, 1:1 + 4 * NG].copy().view(np.float32).reshape(n, NG)
    patch = (raw[:, 1 + 4 * NG:].astype(np.float32) - 20.0) / 180.0
    stats = json.load(open(base + '.json'))
    img = np.concatenate([np.full(r['kept'], i) for i, r in enumerate(stats['perImage'])])[:n] if stats['perImage'] else np.zeros(n)
    return np.concatenate([patch, geom], axis=1).astype(np.float32), y, img


def load(bases):
    Xs, ys, imgs, off = [], [], [], 0
    for b in bases.split(','):
        X, y, img = load_one(b)
        Xs.append(X); ys.append(y); imgs.append(img + off); off += int(img.max()) + 1 if len(img) else 0
    return np.concatenate(Xs), np.concatenate(ys), np.concatenate(imgs)


def augment(xb, rng):
    xb = xb.copy()
    n = len(xb)
    pt = xb[:, :NP].reshape(n, RH, RW)
    dx = rng.integers(-1, 2, n)
    for sx in (-1, 1):
        sel = dx == sx
        if sel.any():
            pt[sel] = np.roll(pt[sel], sx, axis=2)
            pt[sel, :, 0 if sx == 1 else -1] = 0
    dy = rng.integers(-1, 2, n)
    for sy in (-1, 1):
        sel = dy == sy
        if sel.any():
            pt[sel] = np.roll(pt[sel], sy, axis=1)
            pt[sel, 0 if sy == 1 else -1, :] = 0
    pt *= rng.uniform(0.8, 1.2, (n, 1, 1)).astype(np.float32)
    pt += rng.normal(0, 0.03, pt.shape).astype(np.float32)
    xb[:, :NP] = pt.reshape(n, NP)
    return xb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--kind', default='rhythm', choices=list(KINDS))
    ap.add_argument('--epochs', type=int, default=30)
    ap.add_argument('--hidden', default='96,48')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()
    set_kind(args.kind)
    if not args.out:
        args.out = os.path.join(HERE, '..', '..', 'app', 'js', 'omr', 'models', args.kind + '.js')
    X, y, img = load(args.data)
    k = len(CLASSES)
    print('samples', len(y), 'per class', dict(zip(CLASSES, np.bincount(y, minlength=k).tolist())))
    vm = (img % 10) == 0
    Xt, yt, Xv, yv = X[~vm], y[~vm], X[vm], y[vm]
    # rule baseline on the validation images: max(L, R) of the rule-based counter (geometry features 5, 6)
    if KINDS[args.kind]['rule']:
        a, b = KINDS[args.kind]['rule']
        rule = np.minimum(3, np.maximum(Xv[:, NP + a], Xv[:, NP + b])).astype(int)
        print('rule-based val acc', round(float((rule == yv).mean()), 4))
    hidden = tuple(int(v) for v in args.hidden.split(','))
    model = train_mlp(Xt, yt, Xv, yv, hidden=hidden, n_classes=k, epochs=args.epochs, augment=augment, lr=2e-3)
    _, deq = quantize(model)
    pv = predict(deq, Xv).argmax(1)
    print('int8 val acc', round(float((pv == yv).mean()), 4))
    cm = np.zeros((k, k), int)
    for a, b in zip(yv, pv):
        cm[a, b] += 1
    print('confusion (rows = truth', '/'.join(CLASSES) + '):')
    print(cm)
    meta = {'classes': CLASSES, 'rw': RW, 'rh': RH, 'trainedOn': int(len(yt)), 'valAcc': float((pv == yv).mean())}
    size = export_js(model, args.out, args.kind, meta)
    print('wrote', os.path.normpath(args.out), size, 'bytes')


if __name__ == '__main__':
    main()
