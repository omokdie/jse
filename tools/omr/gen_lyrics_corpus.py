#!/usr/bin/env python3
"""Synthetic score pages with Korean lyrics (ground truth per note) for the
lyric-recognition evaluation. Uses gen_synthetic.py for the music and
korean_lyrics.py for the text; writes the same PNG + JSON format, with
`lyrics: [{verse, text, bbox}]` on every note event that carries a syllable.

  python3 tools/omr/gen_lyrics_corpus.py --out tools/omr/corpus_ko --count 24 --seed 9
  python3 tools/omr/gen_lyrics_corpus.py --out tools/omr/corpus_ko --count 6 --start 24 --seed 9 --kinds piano
  python3 tools/omr/augment.py --corpus tools/omr/corpus_ko --per-image 2 --seed 7     # photo-like variants
  python3 tools/omr/gen_lyrics_corpus.py --fixture tools/tests/fixtures/lyrics-page.png  # test page
  node tools/omr/run_eval.mjs --dir tools/omr/corpus_ko --report tools/omr/eval_report_lyrics.md

Page kinds: mono (melody + lyrics under the staff), piano (lyrics between the
treble and bass staves of a grand staff), dense (16ths, tight lyrics).
Fonts: Noto Serif / Sans CJK KR in several weights and WenQuanYi Zen Hei;
1 or 2 verses (verse numbers "1." "2." on some pages).
"""
import argparse, os, random, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gen_synthetic as gs  # noqa: E402
from korean_lyrics import KoreanLyrics  # noqa: E402

KIND_INDEX = {'mono': 0, 'piano': 4, 'dense': 7}     # gen_synthetic.make_config kinds (idx % 9)


def font_set(name):
    """Lyric fonts: 'default' = Noto Serif/Sans KR + WenQuanYi (korean_lyrics.KOREAN_FONTS);
    'holdout' / 'new' = text faces of that group in tools/omr/hangul/gen_data.py (Google Fonts)."""
    if name == 'default':
        return None
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hangul'))
    import gen_data
    out = [(f[0], f[1], f[2]) for f in gen_data.FONTS if f[5] == name and f[6] is None and os.path.exists(f[1])]
    if not out:
        raise SystemExit(f'no fonts for --font-set {name} (run tools/omr/hangul/fetch_fonts.sh)')
    return out


def make_ko_config(rng, idx, kinds=None, fonts=None, sp=None):
    kind = gs.pick(rng, [(6, 'mono'), (3, 'piano'), (2, 'dense')])
    if kinds:
        kind = rng.choice(kinds)
    cfg = gs.make_config(rng, KIND_INDEX[kind] + 9 * rng.randrange(1000))
    if sp:
        cfg['sp'] = rng.choice(sp)
    sp = cfg['sp']
    verses = 1 if (kind == 'piano' or rng.random() < 0.55) else 2
    lrng = random.Random(rng.randrange(1 << 30))
    ly = KoreanLyrics(lrng, sp, verses=verses, font=lrng.choice(fonts) if fonts else None)
    cfg.update(lyrics=True, lyricHook=ly.hook, maxSystems=rng.choice([2, 3, 3, 4]), title=rng.random() < 0.4)
    if kind == 'piano':
        cfg['lyricStaff'] = 0
        cfg['staffGapSp'] = max(cfg['staffGapSp'], 5.0 + ly.space_sp())
        cfg['lyricSpaceSp'] = 0.0
    else:
        cfg['lyricSpaceSp'] = ly.space_sp()
    if kind == 'mono':
        cfg['chordProb'] = 0.0
    cfg['name'] = f'{idx:03d}_ko_{kind}_sp{sp}_w{cfg["pageWidth"]}_v{verses}_{ly.font_name}'
    return cfg, ly


def write_fixture(path_png, seed=11):
    """Small fixed page for tools/tests/lyrics.test.js: one treble staff,
    2 verses with verse numbers, Noto Serif KR, 2 systems."""
    rng = random.Random(seed)
    cfg = gs.make_config(rng, 0)
    cfg.update(pageWidth=1200, pageHeight=1700, sp=10, keyFifths=0, timeSig=(4, 4), timeSigDisplay='digits', accidentalProb=0.0,
               tieProb=0.08, maxSystems=2, title=False, style='simple', staffCount=1, clefs=['treble'], chordProb=0.0)
    ly = KoreanLyrics(random.Random(seed + 1), cfg['sp'], verses=2, font=('serif-regular', '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc', 1),
                      em_sp=1.7, verse_numbers=True)
    cfg.update(lyrics=True, lyricHook=ly.hook, lyricSpaceSp=ly.space_sp(), name='lyrics-page')
    gt = gs.render_page(rng, cfg, path_png, path_png[:-4] + '.json')
    n_syl = sum(len(e.get('lyrics', [])) for m in gt['measures'] for s in m['staves'] for e in s)
    print(f'fixture {path_png}: {gt["width"]}x{gt["height"]} syllables={n_syl}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'corpus_ko'))
    ap.add_argument('--count', type=int, default=24)
    ap.add_argument('--seed', type=int, default=3)
    ap.add_argument('--only', type=int, default=None)
    ap.add_argument('--start', type=int, default=0, help='first page index (to extend a corpus)')
    ap.add_argument('--kinds', default=None, help='restrict page kinds, e.g. piano or mono,dense')
    ap.add_argument('--sp', default=None, help='force the staff space (px), e.g. 6,7 for very small lyrics (em ≈ 9–14 px)')
    ap.add_argument('--font-set', default='default', choices=['default', 'holdout', 'new'], help='lyric fonts (holdout = never trained on)')
    ap.add_argument('--fixture', default=None, help='write the fixed test page (PNG path) and exit')
    args = ap.parse_args()
    if args.fixture:
        write_fixture(args.fixture)
        return
    base_dir = os.path.join(args.out, 'base')
    os.makedirs(base_dir, exist_ok=True)
    for i in range(args.start, args.start + args.count):
        if args.only is not None and i != args.only:
            continue
        rng = random.Random(args.seed * 7777 + i)
        cfg, ly = make_ko_config(rng, i, args.kinds.split(',') if args.kinds else None, font_set(args.font_set), [int(v) for v in args.sp.split(',')] if args.sp else None)
        png = os.path.join(base_dir, cfg['name'] + '.png')
        gt = gs.render_page(rng, cfg, png, png[:-4] + '.json')
        n_syl = sum(len(e.get('lyrics', [])) for m in gt['measures'] for s in m['staves'] for e in s)
        print(f"{cfg['name']}: {gt['width']}x{gt['height']} systems={len(gt['systems'])} syllables={n_syl} em={ly.em}px")


if __name__ == '__main__':
    main()
