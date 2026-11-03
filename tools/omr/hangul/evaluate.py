#!/usr/bin/env python3
"""Evaluate Hangul recogniser models on sample sets written by gen_data.py.

Models are read either from a training checkpoint (train.py --tag … → <data>/<tag>.npz)
or from an exported JS module (app/js/omr/hangul-weights.js, the int8 model the
app ships). Decoding mirrors app/js/omr/hangul.js `readInk`: the type head must say
HANGUL, the best KS X 1001 syllable is chosen by visual log-probability + prior
weight × log prior, and an unconstrained syllable outside KS X 1001 wins only if it
beats that with a fixed penalty.

  python3 tools/omr/hangul/evaluate.py --models v1=/tmp/old-weights.js,new=app/js/omr/hangul-weights.js \\
      --sets /tmp/jse-h2/eval/holdout_clean.npz,/tmp/jse-h2/eval/holdout_small.npz [--by-font] [--by-size]

Prints one row per set: syllable accuracy per model (and symbol accuracy).
"""
import argparse, base64, json, math, os, re, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from charset import TYPE_CLASSES, HANGUL_T, NOISE_T, ks_x_1001_syllables, decompose  # noqa: E402
from core import features  # noqa: E402

KS = ks_x_1001_syllables()
KS_CODES = np.array([ord(c) for c in KS])
KS_IDX = np.array([decompose(c) for c in KS])
KS_SET = set(KS_CODES.tolist())
NON_KS_LOGP = math.log(0.02)


def load_js(path):
    txt = open(path, encoding='utf-8').read()
    doc = json.loads(re.search(r'HANGUL_MODEL = (\{.*\});', txt, re.S).group(1))
    W, b = [], []
    for L in doc['layers']:
        q = np.frombuffer(base64.b64decode(L['w']), np.int8).reshape(L['out'], L['in']).T.astype(np.float32)
        sc = np.frombuffer(base64.b64decode(L['scale']), np.float32)
        W.append(q * sc[None, :])
        b.append(np.frombuffer(base64.b64decode(L['bias']), np.float32).copy())
    prior = None
    if doc.get('prior'):
        q = np.frombuffer(base64.b64decode(doc['prior']['q']), np.uint8)
        prior = (-q.astype(np.float64) * doc['prior']['step'], doc['prior']['weight'], -255 * doc['prior']['step'])
    heads = [n for _, n in doc['heads']]
    return {'W': W, 'b': b, 'mu': None, 'sd': None, 'prior': prior, 'heads': heads, 'name': os.path.basename(path)}


def load_ckpt(path, prior_weight=0.6):
    d = np.load(path, allow_pickle=True)
    from train import load_prior, PRIOR_STEP, HEADS
    q = load_prior()
    prior = (-q.astype(np.float64) * PRIOR_STEP, prior_weight, -255 * PRIOR_STEP) if q is not None and prior_weight else None
    return {'W': list(d['W']), 'b': list(d['b']), 'mu': d['mu'], 'sd': d['sd'], 'prior': prior, 'heads': [n for _, n in HEADS], 'name': os.path.basename(path)}


def load_model(path, prior_weight=0.6):
    return load_js(path) if path.endswith('.js') else load_ckpt(path, prior_weight)


def predict(model, F, bs=4096):
    out = []
    for i in range(0, len(F), bs):
        h = F[i:i + bs].astype(np.float32)
        if model['mu'] is not None:
            h = (h - model['mu']) / model['sd']
        n = len(model['W'])
        for li in range(n):
            h = h @ model['W'][li] + model['b'][li]
            if li < n - 1:
                h = np.maximum(h, 0)
        out.append(h)
    z = np.concatenate(out)
    offs = np.cumsum([0] + model['heads'])
    probs = []
    for k in range(len(model['heads'])):
        y = z[:, offs[k]:offs[k + 1]]
        y = y - y.max(axis=1, keepdims=True)
        e = np.exp(y)
        probs.append(e / e.sum(axis=1, keepdims=True))
    return probs


def decode(model, probs):
    """→ (type argmax, predicted code point or 0) per sample, as hangul.js readInk."""
    pt, pi, pm, pf = probs
    li, lm, lf = np.log(pi + 1e-9), np.log(pm + 1e-9), np.log(pf + 1e-9)
    vis = li[:, KS_IDX[:, 0]] + lm[:, KS_IDX[:, 1]] + lf[:, KS_IDX[:, 2]]
    rank = vis
    unseen = 0.0
    if model['prior'] is not None:
        lp, w, unseen_lp = model['prior']
        rank = vis + w * lp[None, :]
        unseen = w * unseen_lp
    j = np.argmax(rank, axis=1)
    best_rank = rank[np.arange(len(j)), j]
    code = KS_CODES[j].copy()
    bi, bm, bf = pi.argmax(1), pm.argmax(1), pf.argmax(1)
    s_free = li[np.arange(len(bi)), bi] + lm[np.arange(len(bm)), bm] + lf[np.arange(len(bf)), bf]
    free = 0xAC00 + (bi * 21 + bm) * 28 + bf
    use_free = np.array([c not in KS_SET for c in free.tolist()]) & (s_free + NON_KS_LOGP + unseen > best_rank)
    code[use_free] = free[use_free]
    t = pt.argmax(1)
    return t, code


def confidence(probs, code, t):
    """P(HANGUL) × p(i) p(m) p(f) of the decoded syllable (as readInk's conf)."""
    pt, pi, pm, pf = probs
    k = np.clip(code - 0xAC00, 0, 11171)
    n = np.arange(len(k))
    return pt[n, HANGUL_T] * pi[n, k // 588] * pm[n, (k % 588) // 28] * pf[n, k % 28]


def evaluate(model, d, F, FT=None, gate=0.0):
    """FT: features of the extra crops (N, 2, 768); tokens whose first read has
    confidence < gate are re-read: head probabilities averaged over the 3 crops."""
    L, C = d['L'], d['C']
    probs = predict(model, F)
    t, code = decode(model, probs)
    if FT is not None and gate > 0:
        conf = confidence(probs, code, t)
        redo = np.nonzero(conf < gate)[0]
        if len(redo):
            extra = [predict(model, FT[redo, k]) for k in range(FT.shape[1])]
            avg = [(probs[h][redo] + sum(e[h] for e in extra)) / (1 + len(extra)) for h in range(len(probs))]
            t2, code2 = decode(model, avg)
            t, code = t.copy(), code.copy()
            t[redo], code[redo] = t2, code2
        model['_redo'] = len(redo) / len(F)
    hang = L[:, 0] == HANGUL_T
    sym = (L[:, 0] != HANGUL_T) & (L[:, 0] != NOISE_T)
    ok_h = (t == HANGUL_T) & (code == C)
    ok_s = t == L[:, 0]
    return ok_h, ok_s, hang, sym


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', required=True, help='name=path[,name=path…] (.js weights or .npz checkpoint)')
    ap.add_argument('--sets', required=True, help='comma-separated .npz sets')
    ap.add_argument('--prior-weight', type=float, default=0.6, help='for checkpoints (JS weights carry their own)')
    ap.add_argument('--no-prior', action='store_true', help='visual model only (the sets draw syllables uniformly, unlike real text)')
    ap.add_argument('--by-font', action='store_true')
    ap.add_argument('--by-size', action='store_true')
    ap.add_argument('--json', default=None)
    ap.add_argument('--tta-gate', type=float, default=0.0, help='re-read tokens below this confidence with the extra crops (sets with XT)')
    args = ap.parse_args()
    models = []
    for item in args.models.split(','):
        name, path = item.split('=', 1) if '=' in item else (os.path.basename(item), item)
        m = load_model(path, args.prior_weight)
        if args.no_prior:
            m['prior'] = None
        models.append((name, m))
    import gen_data
    res = {}
    head = f'{"set":34s} {"n(hangul/sym)":>14s} ' + ' '.join(f'{n:>16s}' for n, _ in models)
    print(head)
    for sp in args.sets.split(','):
        d = np.load(sp)
        F = np.concatenate([features(d['X'][i:i + 2048].astype(np.float64) / 255.0) for i in range(0, len(d['X']), 2048)]).astype(np.float32)
        FT = None
        if args.tta_gate > 0 and 'XT' in d.files:
            XT = d['XT']
            FT = np.stack([np.concatenate([features(XT[i:i + 2048, k].astype(np.float64) / 255.0) for i in range(0, len(XT), 2048)]).astype(np.float32)
                           for k in range(XT.shape[1])], axis=1)
        name = os.path.basename(sp)[:-4] + (f' (re-read < {args.tta_gate})' if FT is not None else '')
        cols, per = [], {}
        for mn, m in models:
            ok_h, ok_s, hang, sym = evaluate(m, d, F, FT, args.tta_gate)
            cols.append(f'{100 * ok_h[hang].mean():6.2f}% / {100 * ok_s[sym].mean():5.1f}%' + (f' re-read {100 * m.get("_redo", 0):.0f}%' if FT is not None else ''))
            per[mn] = {'syllable': float(ok_h[hang].mean()), 'symbol': float(ok_s[sym].mean()) if sym.any() else None}
            if args.by_font:
                fam = {}
                for fi in sorted(set(d['F'][hang].tolist())):
                    nm = gen_data.FONTS[fi][0]
                    fam.setdefault(re.sub(r'-(thin|extralight|light|demilight|regular|medium|semibold|bold|extrabold|black|\d+)$', '', nm), []).append(fi)
                per[mn]['font'] = {k: round(float(ok_h[hang & np.isin(d['F'], v)].mean()), 4) for k, v in fam.items()}
            groups = {}
            for fi in set(d['F'][hang].tolist()):
                groups.setdefault(gen_data.FONTS[fi][5], []).append(fi)
            if len(groups) > 1:
                per[mn]['group'] = {k: round(float(ok_h[hang & np.isin(d['F'], v)].mean()), 4) for k, v in sorted(groups.items())}
            if args.by_size and 'E' in d.files:
                E = d['E']
                per[mn]['size'] = {f'{a}-{b}': round(float(ok_h[hang & (E >= a) & (E < b)].mean()), 4) for a, b in ((9, 11), (11, 13), (13, 16), (16, 22), (22, 30), (30, 49)) if (hang & (E >= a) & (E < b)).any()}
        res[name] = per
        print(f'{name:34s} {int(hang.sum()):6d}/{int(sym.sum()):<6d} ' + ' '.join(f'{c:>16s}' for c in cols), flush=True)
        for mn, _ in models:
            for key in ('group', 'font', 'size'):
                if key in per[mn]:
                    print(f'    {mn} by {key}: ' + '  '.join(f'{k} {100 * v:.1f}' for k, v in per[mn][key].items()))
    if args.json:
        json.dump(res, open(args.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
