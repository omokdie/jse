#!/usr/bin/env python3
"""Tiny numpy MLP trainer + int8 exporter for the JSE OMR classifiers.

  model = train_mlp(X, y, hidden=(64, 32), n_classes=4, ...)
  export_js(model, path, name, meta)   # app/js/omr/models/<name>.js

Architecture: dense → ReLU → dense → ReLU → dense → softmax, inputs
standardised (mean / std stored with the model).  Training: Adam, mini
batches, class-balanced loss weights, L2, optional augmentation callback,
early stopping on a validation set.  Export: weights int8 with one scale per
output unit, biases / scales / normalisation float32, all base64 — decoded
lazily by app/js/omr/classifiers.js.
"""
import base64, json, math, time
import numpy as np


def _init(rng, n_in, n_out):
    return rng.normal(0, math.sqrt(2.0 / n_in), (n_in, n_out)).astype(np.float32), np.zeros(n_out, np.float32)


def forward(params, X, keep=None):
    acts = [X]
    h = X
    for i, (W, b) in enumerate(params):
        h = h @ W + b
        if i < len(params) - 1:
            h = np.maximum(h, 0)
            if keep is not None:
                h = h * keep[i]
        acts.append(h)
    return acts


def softmax(z):
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def train_mlp(X, y, Xv, yv, hidden=(64, 32), n_classes=4, epochs=30, batch=256, lr=2e-3, l2=1e-4,
              class_weight=None, augment=None, seed=0, dropout=0.1, verbose=True):
    rng = np.random.default_rng(seed)
    mean = X.mean(axis=0).astype(np.float32)
    std = (X.std(axis=0) + 1e-3).astype(np.float32)
    sizes = [X.shape[1], *hidden, n_classes]
    params = [_init(rng, a, b) for a, b in zip(sizes[:-1], sizes[1:])]
    m = [[np.zeros_like(W), np.zeros_like(b)] for W, b in params]
    v = [[np.zeros_like(W), np.zeros_like(b)] for W, b in params]
    if class_weight is None:
        cnt = np.bincount(y, minlength=n_classes).astype(np.float64)
        class_weight = (cnt.sum() / (n_classes * np.maximum(cnt, 1))) ** 0.5
    cw = np.asarray(class_weight, np.float32)
    t = 0
    best = (-1, None)
    Xvn = (Xv - mean) / std
    for ep in range(epochs):
        t0 = time.time()
        order = rng.permutation(len(X))
        lr_ep = lr * (0.5 * (1 + math.cos(math.pi * ep / epochs)))
        tot = 0.0
        for k in range(0, len(order), batch):
            idx = order[k:k + batch]
            xb = X[idx]
            if augment is not None:
                xb = augment(xb, rng)
            xb = (xb - mean) / std
            yb = y[idx]
            keep = None
            if dropout:
                keep = [(rng.random((len(idx), hdim)) > dropout).astype(np.float32) / (1 - dropout) for hdim in hidden]
            acts = forward(params, xb, keep)
            p = softmax(acts[-1])
            wts = cw[yb]
            tot += float(-(np.log(p[np.arange(len(yb)), yb] + 1e-9) * wts).sum())
            g = p
            g[np.arange(len(yb)), yb] -= 1
            g *= (wts / wts.sum())[:, None]
            t += 1
            for i in range(len(params) - 1, -1, -1):
                W, b = params[i]
                gW = acts[i].T @ g + l2 * W
                gb = g.sum(axis=0)
                if i > 0:
                    g = (g @ W.T) * (acts[i] > 0)
                    if keep is not None:
                        g = g * keep[i - 1]
                for j, (P, G) in enumerate(((W, gW), (b, gb))):
                    m[i][j] = 0.9 * m[i][j] + 0.1 * G
                    v[i][j] = 0.999 * v[i][j] + 0.001 * G * G
                    mh = m[i][j] / (1 - 0.9 ** t); vh = v[i][j] / (1 - 0.999 ** t)
                    P -= lr_ep * mh / (np.sqrt(vh) + 1e-8)
        pv = softmax(forward(params, Xvn)[-1])
        acc = float((pv.argmax(1) == yv).mean())
        bal = balanced_acc(yv, pv.argmax(1), n_classes)
        if verbose:
            print(f'epoch {ep + 1:2d} loss {tot / len(X):.4f} val acc {acc:.4f} balanced {bal:.4f} ({time.time() - t0:.1f}s)', flush=True)
        score = bal * 0.5 + acc * 0.5
        if score > best[0]:
            best = (score, [(W.copy(), b.copy()) for W, b in params])
    return {'params': best[1], 'mean': mean, 'std': std, 'classes': n_classes}


def balanced_acc(y, pred, n):
    accs = [float((pred[y == c] == c).mean()) for c in range(n) if (y == c).any()]
    return sum(accs) / len(accs)


def predict(model, X):
    Xn = (X - model['mean']) / model['std']
    return softmax(forward(model['params'], Xn)[-1])


def quantize(model):
    """int8 weights per output unit; returns a model usable by predict() (dequantised)."""
    q = []
    for W, b in model['params']:
        scale = np.abs(W).max(axis=0) / 127.0 + 1e-12
        Wq = np.clip(np.round(W / scale), -127, 127).astype(np.int8)
        q.append((Wq, scale.astype(np.float32), b.astype(np.float32)))
    deq = dict(model, params=[(Wq.astype(np.float32) * s, b) for Wq, s, b in q])
    return q, deq


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode('ascii')


def export_js(model, path, name, meta):
    q, _ = quantize(model)
    layers = []
    for Wq, s, b in q:
        n_in, n_out = Wq.shape
        # stored row-major by output unit: w[o * n_in + i]
        layers.append({'in': int(n_in), 'out': int(n_out), 'w': b64(Wq.T.copy()), 's': b64(s), 'b': b64(b)})
    obj = {'name': name, 'mean': b64(model['mean']), 'std': b64(model['std']), 'layers': layers, 'meta': meta}
    js = (f'// Auto-generated by tools/omr/train_{name}.py — do not edit.\n'
          f'// MLP {" → ".join(str(l["in"]) for l in layers)} → {layers[-1]["out"]}, int8 weights (per-unit scales), base64.\n'
          f'export const MODEL = {json.dumps(obj, separators=(",", ":"))};\n')
    with open(path, 'w') as f:
        f.write(js)
    return len(js)
