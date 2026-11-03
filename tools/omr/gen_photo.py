#!/usr/bin/env python3
"""Realistic photographed-score corpus with exact ground truth.

1. Renders clean full pages (A4 at ~300 dpi) with the synthetic score
   generator (gen_synthetic.py, imported — its random content, glyphs and GT
   format), recording every glyph that is drawn (noteheads, rests,
   accidentals, clefs, digits, ...) as symbol-level ground truth.
   With --pages DIR, clean pages (PNG + GT JSON in the same format, e.g.
   rendered from the Finale corpus by gen_finale_pages.mjs) are used instead.
2. Turns every page into one or more phone photos / scans with photo_sim.py
   (perspective, curl, lighting, blur, noise, JPEG...).

Output (per split):
  <out>/<split>_clean/<name>.png + .json     clean page, page-pixel GT
  <out>/<split>_photo/<name>_<kind>.jpg + .json  photo, photo-pixel GT

GT JSON = gen_synthetic format + `symbols: [{name, bbox, c}]` (+ `photo`
parameters).  Splits use disjoint seed ranges:
  eval  : seed 9001  — fixed evaluation split, never tuned or trained on
  dev   : seed 5001  — for tuning heuristics
  train : seed 100001 — for training learned components

Usage:
  python3 tools/omr/gen_photo.py --split eval --count 48
  python3 tools/omr/gen_photo.py --split dev --count 32
  python3 tools/omr/gen_photo.py --split train --count 300 --out /tmp/omr_train --no-clean
"""
import argparse, json, os, random, sys, time
import numpy as np
import cv2
if os.environ.get('OMR_THREADS'):
    cv2.setNumThreads(int(os.environ['OMR_THREADS']))

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gen_synthetic as GS  # noqa: E402
import photo_sim as PS      # noqa: E402

SPLIT_SEEDS = {'eval': 9001, 'dev': 5001, 'train': 100001}
A4_W, A4_H = 2480, 3508

# ----------------------------------------------------------------------------
# glyph recorder (symbol-level ground truth) — wraps gen_synthetic.Page.glyph
# ----------------------------------------------------------------------------
_orig_glyph = GS.Page.glyph


def _recording_glyph(self, name, ax, ay, **kw):
    bb = _orig_glyph(self, name, ax, ay, **kw)
    if not hasattr(self, 'symbols'):
        self.symbols = []
    self.symbols.append({'name': name, 'bbox': [float(v) for v in bb], 'c': [round(float(ax), 2), round(float(ay), 2)]})
    return bb


GS.Page.glyph = _recording_glyph
_pages_made = []
_orig_init = GS.Page.__init__


def _tracking_init(self, *a, **kw):
    _orig_init(self, *a, **kw)
    self.symbols = []
    _pages_made.append(self)


GS.Page.__init__ = _tracking_init


def page_config(rng, idx):
    cfg = GS.make_config(rng, idx)
    sp = rng.uniform(16, 26)
    margin = rng.uniform(130, 250)
    cfg.update(pageWidth=A4_W, pageHeight=A4_H, sp=sp, marginSp=margin / sp)
    staff_count = cfg['staffCount']
    lyr = 2.5 if cfg.get('lyrics') else 0.0
    sys_h = staff_count * 4 + (staff_count - 1) * cfg['staffGapSp']
    pitch = sys_h + cfg['systemGapSp'] + lyr
    y0 = margin + (4 * sp if cfg['title'] else 0) + 3 * sp
    n_fit = int((A4_H - margin - y0 + cfg['systemGapSp'] * sp) / (pitch * sp))
    n_fit = max(1, n_fit)
    cfg['maxSystems'] = rng.randint(min(2, n_fit), n_fit)
    cfg['measures'] = 96
    cfg['name'] = f"{idx:03d}_{cfg['name'].split('_', 1)[1].split('_sp')[0]}"
    return cfg


def render_clean(rng, idx, out_dir):
    cfg = page_config(rng, idx)
    png = os.path.join(out_dir, cfg['name'] + '.png')
    _pages_made.clear()
    gt = GS.render_page(rng, cfg, png, png[:-4] + '.json')
    pg = _pages_made[-1]
    img = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
    # a page that is mostly empty is either a full sheet (pad with paper) or,
    # half of the time, photographed as an excerpt (keep the content crop)
    if img.shape[0] < A4_H and not (img.shape[0] < 0.6 * A4_H and rng.random() < 0.5):
        img = np.vstack([img, np.full((A4_H - img.shape[0], img.shape[1]), 255, np.uint8)])
        cv2.imwrite(png, img)
    gt['height'] = int(img.shape[0])
    gt['symbols'] = pg.symbols
    annotate_symbols(gt)
    gt['source'] = 'synthetic'
    with open(png[:-4] + '.json', 'w') as f:
        json.dump(gt, f)
    return png, gt


def annotate_symbols(gt):
    """Marks symbols drawn inside a measure (vs. clef / key / time header) and
    lists the right barline of every measure as a segment (page coords)."""
    boxes = [m['bbox'] for m in gt['measures']]
    for s in gt['symbols']:
        b = s['bbox']
        cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
        s['inMeasure'] = any(m[0] <= cx <= m[0] + m[2] and m[1] - 8 * gt['staffSpace'] <= cy <= m[1] + m[3] + 8 * gt['staffSpace'] for m in boxes)
    gt['barlines'] = [{'x': m['bbox'][0] + m['bbox'][2], 'y0': m['bbox'][1], 'y1': m['bbox'][1] + m['bbox'][3],
                       'type': m.get('barlineRight', 'single')} for m in gt['measures']]


def profile_kind(i):
    # fixed mix: 20 % scans, 35 % flat photos, 25 % curled / book, 20 % hard
    return ['flat', 'curl', 'scan', 'flat', 'hard', 'flat', 'curl', 'flat', 'scan', 'curl',
            'flat', 'hard', 'curl', 'flat', 'scan', 'hard', 'flat', 'curl', 'hard', 'scan'][i % 20]


def write_photo(page, gt, rng, kind, out_dir, name, back=None, keep_symbols=True):
    prof = PS.sample_profile(rng, kind)
    t0 = time.time()
    photo, g, q, geo = PS.simulate(page.astype(np.float32), gt, rng, prof, back=back)
    g['image'] = f'{name}_{kind}.jpg' if q else f'{name}_{kind}.png'
    g['photo'] = {k: v for k, v in prof.items() if k not in ('background',)}
    if not keep_symbols:
        g.pop('symbols', None)
    path = os.path.join(out_dir, g['image'])
    if q:
        # already JPEG-decoded; store at a quality that does not add new artefacts
        cv2.imwrite(path, photo, [cv2.IMWRITE_JPEG_QUALITY, 97])
    else:
        cv2.imwrite(path, cv2.cvtColor(photo, cv2.COLOR_BGR2GRAY))   # lossless scans are grey PNGs
    with open(path.rsplit('.', 1)[0] + '.json', 'w') as f:
        json.dump(round_floats(g), f, separators=(',', ':'))
    return path, g, time.time() - t0


def round_floats(o, nd=2):
    if isinstance(o, float):
        return round(o, nd)
    if isinstance(o, list):
        return [round_floats(v, nd) for v in o]
    if isinstance(o, dict):
        return {k: round_floats(v, nd) for k, v in o.items()}
    return o


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(HERE, 'corpus'))
    ap.add_argument('--split', default='eval', choices=list(SPLIT_SEEDS))
    ap.add_argument('--count', type=int, default=48)
    ap.add_argument('--start', type=int, default=0)
    ap.add_argument('--per-page', type=int, default=1, help='photos per clean page')
    ap.add_argument('--pages', default=None, help='use clean pages (png+json) from this directory instead of synthetic ones')
    ap.add_argument('--no-clean', action='store_true', help='do not keep the clean pages')
    ap.add_argument('--kinds', default=None, help='comma list of profile kinds to use (default: fixed mix)')
    ap.add_argument('--fast', action='store_true', help='faster noise / texture synthesis (default for the train split)')
    args = ap.parse_args()
    base_seed = SPLIT_SEEDS[args.split]
    PS.FAST = args.fast or args.split == 'train'
    clean_dir = os.path.join(args.out, f'{args.split}_clean')
    photo_dir = os.path.join(args.out, f'{args.split}_photo')
    os.makedirs(photo_dir, exist_ok=True)
    os.makedirs(clean_dir, exist_ok=True)
    kinds = args.kinds.split(',') if args.kinds else None
    sources = None
    if args.pages:
        sources = sorted(os.path.join(args.pages, f) for f in os.listdir(args.pages) if f.endswith('.png') and os.path.exists(os.path.join(args.pages, f[:-4] + '.json')))
    prev = None
    for i in range(args.start, args.start + args.count):
        rng = random.Random(base_seed * 1000 + i)
        t0 = time.time()
        if sources:
            src = sources[i % len(sources)]
            gt = json.load(open(src[:-4] + '.json'))
            if gt.get('symbols') and 'barlines' not in gt:
                annotate_symbols(gt)
            page = cv2.imread(src, cv2.IMREAD_GRAYSCALE)
            name = f'{i:03d}_' + os.path.basename(src)[:-4]
        else:
            png, gt = render_clean(rng, i, clean_dir)
            page = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
            name = os.path.basename(png)[:-4]
            if args.no_clean:
                os.remove(png); os.remove(png[:-4] + '.json')
        t_page = time.time() - t0
        for k in range(args.per_page):
            kind = (kinds[(i * args.per_page + k) % len(kinds)] if kinds else profile_kind(i * args.per_page + k))
            path, g, t_photo = write_photo(page, gt, rng, kind, photo_dir, name if args.per_page == 1 else f'{name}{k}', back=prev)
            n_notes = sum(1 for m in g['measures'] for s in m['staves'] for e in s if e['kind'] == 'note')
            print(f"{os.path.basename(path)}: {g['width']}x{g['height']} sp={g['staffSpace']:.1f} measures={len(g['measures'])} "
                  f"notes={n_notes} page {t_page:.1f}s photo {t_photo:.1f}s", flush=True)
        prev = page


if __name__ == '__main__':
    main()
