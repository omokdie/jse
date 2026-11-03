#!/usr/bin/env python3
"""Synthetic printed-score corpus generator for the JSE OMR evaluation.

Renders random but musically well-formed pages (FreeSerif glyphs + plain
line drawing) and writes ground truth JSON next to each PNG:

  corpus/base/<name>.png
  corpus/base/<name>.json   {
     image, width, height, staffSpace, lineThickness, keyFifths, timeSig,
     staffCount, clefs, systems:[{staves:[{clef, lines:[[x,y]...]x5, bbox}], measureIndices}],
     measures:[{bbox, staves:[[event...]...]}]
  }
  event = {kind:"note"|"rest", base, dots, pitches:["C4","F#4"], tieStart, tieEnd, x, bbox}

Usage: python3 tools/omr/gen_synthetic.py --out tools/omr/corpus --count 40 --seed 1
"""
import argparse, json, math, os, random, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from music_glyphs import GlyphRaster, draw_glyph, fill_polygon, fill_rect, blit, SERIF  # noqa: E402

STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F']
CLEF_TOP = {'treble': ('F', 5), 'bass': ('A', 3), 'alto': ('G', 4)}
TICKS = {'whole': 3840, 'half': 1920, 'quarter': 960, 'eighth': 480, '16th': 240, '32nd': 120}
FLAGS = {'eighth': 1, '16th': 2, '32nd': 3}
LYRIC_SYLLABLES = ['la', 'ra', 'do', 'mi', 'na', 'sol', 'ti', 'lu', 'sa', 'ne', 'ka', 'me', 'da', 'ro', 'ha']
TITLES = ['Etude No. 3', 'Morning Song', 'Sonatina', 'Menuet', 'Romanze', 'Study in C', 'Lied', 'Prelude']


def diatonic(step, octave):
    return octave * 7 + STEPS.index(step)


def staff_pos(step, octave, clef):
    ts, to = CLEF_TOP[clef]
    return diatonic(ts, to) - diatonic(step, octave)


def note_at_pos(pos, clef):
    ts, to = CLEF_TOP[clef]
    idx = diatonic(ts, to) - pos
    return STEPS[idx % 7], idx // 7


def key_alter(step, fifths):
    if fifths > 0:
        return 1 if step in SHARP_ORDER[:fifths] else 0
    if fifths < 0:
        return -1 if step in FLAT_ORDER[:-fifths] else 0
    return 0


def pitch_name(step, octave, alter):
    return step + {-2: 'bb', -1: 'b', 0: '', 1: '#', 2: 'x'}[alter] + str(octave)


def dur_ticks(base, dots):
    t = TICKS[base]
    return t * (1.5 if dots == 1 else 1.75 if dots == 2 else 1)


# ----------------------------------------------------------------------------
# musical content
# ----------------------------------------------------------------------------
# beat patterns: list of (base, dots, isRest); 'q' quarter 'e' eighth 's' 16th
BEAT_PATTERNS_SIMPLE = [
    (12, [('quarter', 0, False)]),
    (10, [('eighth', 0, False), ('eighth', 0, False)]),
    (4, [('eighth', 0, False), ('16th', 0, False), ('16th', 0, False)]),
    (4, [('16th', 0, False), ('16th', 0, False), ('eighth', 0, False)]),
    (4, [('16th', 0, False)] * 4),
    (3, [('eighth', 1, False), ('16th', 0, False)]),
    (3, [('quarter', 0, True)]),
    (2, [('eighth', 0, False), ('eighth', 0, True)]),
    (2, [('eighth', 0, True), ('eighth', 0, False)]),
]
TWO_BEAT_PATTERNS = [
    (6, [('half', 0, False)]),
    (3, [('quarter', 1, False), ('eighth', 0, False)]),
    (1, [('half', 0, True)]),
]
BEAT_PATTERNS_COMPOUND = [  # dotted-quarter beat (6/8)
    (6, [('quarter', 1, False)]),
    (8, [('eighth', 0, False)] * 3),
    (4, [('quarter', 0, False), ('eighth', 0, False)]),
    (3, [('eighth', 0, False), ('quarter', 0, False)]),
    (2, [('eighth', 0, False), ('eighth', 0, True), ('eighth', 0, False)]),
    (1, [('quarter', 1, True)]),
]


def pick(rng, weighted):
    tot = sum(w for w, _ in weighted)
    r = rng.random() * tot
    for w, v in weighted:
        r -= w
        if r <= 0:
            return v
    return weighted[-1][1]


def gen_rhythm(rng, time_sig, style):
    num, den = time_sig
    out = []
    if den == 8 and num % 3 == 0:
        for _ in range(num // 3):
            out += pick(rng, BEAT_PATTERNS_COMPOUND)
        return out
    beats = num * 4 // den
    if beats == 4 and rng.random() < 0.06:
        return [('whole', 0, rng.random() < 0.3)]
    b = 0
    while b < beats:
        if beats - b >= 2 and rng.random() < 0.25:
            out += pick(rng, TWO_BEAT_PATTERNS); b += 2
        else:
            pats = BEAT_PATTERNS_SIMPLE
            if style == 'simple':
                pats = [p for p in pats if all(d[0] != '16th' for d in p[1])]
            out += pick(rng, pats); b += 1
    return out


class Melody:
    """Random-walk pitch generator with per-measure accidental state."""

    def __init__(self, rng, clef, fifths, lo_pos, hi_pos):
        self.rng, self.clef, self.fifths = rng, clef, fifths
        self.lo, self.hi = lo_pos, hi_pos          # staff positions (hi is numerically smaller)
        self.pos = (lo_pos + hi_pos) // 2
        self.state = {}

    def new_measure(self):
        self.state = {}

    def next_pos(self):
        step = pick(self.rng, [(5, 0), (8, 1), (8, -1), (4, 2), (4, -2), (2, 3), (2, -3), (1, 4), (1, -4)])
        p = self.pos + step
        if p > self.lo or p < self.hi:
            p = self.pos - step
        p = max(self.hi, min(self.lo, p))
        self.pos = p
        return p

    def note(self, pos, accidental_prob):
        step, octave = note_at_pos(pos, self.clef)
        key = (step, octave)
        cur = self.state.get(key, key_alter(step, self.fifths))
        acc = None
        if self.rng.random() < accidental_prob:
            choices = [a for a in (-1, 0, 1) if a != cur]
            alt = self.rng.choice(choices)
            acc = {-1: 'flat', 0: 'natural', 1: 'sharp'}[alt]
            self.state[key] = alt
            cur = alt
        return {'step': step, 'octave': octave, 'alter': cur, 'pos': pos, 'accidental': acc}


def gen_score(rng, cfg):
    """Returns dict with measures[], each measure: staves[] of event lists."""
    staff_count = cfg['staffCount']
    clefs = cfg['clefs']
    fifths = cfg['keyFifths']
    time_sig = cfg['timeSig']
    n_meas = cfg['measures']
    ranges = {'treble': (10, -3), 'bass': (10, -2), 'alto': (9, -1)}
    melodies = [Melody(rng, clefs[i], fifths, *ranges[clefs[i]]) for i in range(staff_count)]
    measures = []
    prev_last = [None] * staff_count
    for mi in range(n_meas):
        staves = []
        for si in range(staff_count):
            mel = melodies[si]
            mel.new_measure()
            rhythm = gen_rhythm(rng, time_sig, cfg['style'])
            events = []
            for base, dots, is_rest in rhythm:
                if is_rest:
                    events.append({'kind': 'rest', 'base': base, 'dots': dots})
                    continue
                pos = mel.next_pos()
                notes = [mel.note(pos, cfg['accidentalProb'])]
                if cfg['chordProb'] > 0 and rng.random() < cfg['chordProb'] and base != 'whole':
                    n_extra = 1 if rng.random() < 0.7 else 2
                    p = pos
                    for _ in range(n_extra):
                        p -= pick(rng, [(6, 2), (3, 3), (1, 1), (2, 4)])
                        if p < mel.hi - 1:
                            break
                        notes.insert(0, mel.note(p, cfg['accidentalProb'] * 0.5))
                    notes.sort(key=lambda n: -n['pos'])   # low -> high (large pos first)
                events.append({'kind': 'note', 'base': base, 'dots': dots, 'notes': notes,
                               'tieStart': False, 'tieEnd': False})
            # ties: within the measure (repeat the previous pitch) or from the previous measure
            for i in range(1, len(events)):
                a, b = events[i - 1], events[i]
                if a['kind'] == 'note' and b['kind'] == 'note' and len(a['notes']) == 1 and len(b['notes']) == 1 \
                        and rng.random() < cfg['tieProb']:
                    b['notes'] = [dict(a['notes'][0], accidental=None)]
                    a['tieStart'] = True; b['tieEnd'] = True
                    mel.pos = b['notes'][0]['pos']
            if prev_last[si] is not None and events and events[0]['kind'] == 'note' and len(events[0]['notes']) == 1 \
                    and prev_last[si]['kind'] == 'note' and len(prev_last[si]['notes']) == 1 and rng.random() < cfg['tieProb']:
                pn = prev_last[si]['notes'][0]
                # the tied-over note keeps the pitch; an accidental is not re-displayed across the tie
                events[0]['notes'] = [dict(pn, accidental=None)]
                mel.state[(pn['step'], pn['octave'])] = pn['alter']
                prev_last[si]['tieStart'] = True; events[0]['tieEnd'] = True
            prev_last[si] = events[-1] if events else None
            staves.append(events)
        bl = 'single'
        if mi == n_meas - 1:
            bl = 'final'
        elif rng.random() < 0.06:
            bl = rng.choice(['double', 'repeat-end'])
        measures.append({'staves': staves, 'barlineRight': bl})
    return {'measures': measures}


# ----------------------------------------------------------------------------
# layout + rendering
# ----------------------------------------------------------------------------
class Page:
    def __init__(self, W, H, sp, cfg, rng):
        self.W, self.H, self.sp = W, H, sp
        self.img = np.full((H, W), 255.0, np.float32)
        self.gr = GlyphRaster()
        self.cfg, self.rng = cfg, rng
        self.lt = cfg['lineThick'] * sp        # staff line thickness (px)
        self.stem_w = cfg['stemThick'] * sp
        self.beam_h = cfg['beamThick'] * sp

    def hline(self, x0, x1, y, th):
        fill_rect(self.img, x0, y - th / 2, x1, y + th / 2)

    def vline(self, x, y0, y1, th):
        fill_rect(self.img, x - th / 2, y0, x + th / 2, y1)

    def glyph(self, name, ax, ay, **kw):
        return draw_glyph(self.img, self.gr, name, self.sp, ax, ay, **kw)

    def text(self, s, x, y, size):
        font = ImageFont.truetype(SERIF, max(6, int(size)))
        l, t, r, b = font.getbbox(s)
        m = Image.new('L', (r - l + 4, b - t + 4), 0)
        ImageDraw.Draw(m).text((2 - l, 2 - t), s, font=font, fill=255)
        a = np.asarray(m, np.float32) / 255.0
        blit(self.img, a, int(x), int(y))

    def save(self, path):
        Image.fromarray(self.img.clip(0, 255).astype(np.uint8)).save(path)


def event_width_sp(ev, cfg):
    base = {'whole': 6.5, 'half': 5.0, 'quarter': 3.6, 'eighth': 2.6, '16th': 2.0, '32nd': 1.8}[ev['base']]
    w = base * cfg['spacing']
    if ev.get('dots'):
        w += 0.7
    if ev['kind'] == 'note' and any(n['accidental'] for n in ev['notes']):
        w += 1.1
    if ev['kind'] == 'note' and len(ev['notes']) > 1:
        w += 0.5
    return w


def key_sig_positions(fifths, clef):
    """Staff positions of key signature accidentals for a clef."""
    if fifths == 0:
        return []
    if fifths > 0:
        base = {'treble': [0, 3, -1, 2, 5, 1, 4], 'bass': [2, 5, 1, 4, 7, 3, 6], 'alto': [1, 4, 0, 3, 6, 2, 5]}[clef]
        return [('sharp', p) for p in base[:fifths]]
    base = {'treble': [4, 1, 5, 2, 6, 3, 7], 'bass': [6, 3, 7, 4, 8, 5, 9], 'alto': [5, 2, 6, 3, 7, 4, 8]}[clef]
    return [('flat', p) for p in base[:-fifths]]


def beam_groups(events, time_sig):
    """Group consecutive flagged notes into beams by beat. Returns list of lists of event indices."""
    num, den = time_sig
    beat = 1440 if (den == 8 and num % 3 == 0) else 960
    groups, cur, t = [], [], 0
    for i, ev in enumerate(events):
        d = dur_ticks(ev['base'], ev['dots'])
        beamable = ev['kind'] == 'note' and ev['base'] in FLAGS
        start_beat = t // beat
        end_beat = (t + d - 1) // beat
        if beamable and start_beat == end_beat:
            if cur and cur[-1][1] != start_beat:
                groups.append([j for j, _ in cur]); cur = []
            cur.append((i, start_beat))
        else:
            if cur:
                groups.append([j for j, _ in cur]); cur = []
        t += d
    if cur:
        groups.append([j for j, _ in cur])
    return [g for g in groups if len(g) >= 2]


def render_page(rng, cfg, out_png, out_json):
    sp = cfg['sp']
    W = cfg['pageWidth']
    page_h_guess = cfg['pageHeight']
    pg = Page(W, page_h_guess, sp, cfg, rng)
    score = gen_score(rng, cfg)
    clefs = cfg['clefs']
    staff_count = cfg['staffCount']
    time_sig = cfg['timeSig']
    fifths = cfg['keyFifths']
    margin = cfg['marginSp'] * sp
    gt = {'image': os.path.basename(out_png), 'width': W, 'height': page_h_guess, 'staffSpace': sp,
          'lineThickness': pg.lt, 'keyFifths': fifths, 'timeSig': {'num': time_sig[0], 'den': time_sig[1]},
          'staffCount': staff_count, 'clefs': clefs, 'systems': [], 'measures': []}

    # --- break measures into systems by natural width -------------------
    nat_w = []
    for m in score['measures']:
        w = 0
        for ev_list in m['staves']:
            w = max(w, sum(event_width_sp(ev, cfg) for ev in ev_list))
        nat_w.append(w * sp + 1.5 * sp + (1.3 * sp if m['barlineRight'] != 'single' else 0))
    x_left = margin + (2.0 * sp if staff_count == 2 else 0)
    x_right = W - margin
    header_w = 4.0 * sp + (len(key_sig_positions(fifths, 'treble')) * 1.05 + 0.6) * sp
    systems, cur, cur_w = [], [], 0
    for mi, w in enumerate(nat_w):
        hw = header_w + (3.5 * sp if mi == 0 else 0)
        avail = x_right - x_left - (hw if not cur else (header_w + 0))
        if cur and cur_w + w > avail:
            systems.append(cur); cur, cur_w = [], 0
        cur.append(mi); cur_w += w
    if cur:
        systems.append(cur)
    if cfg.get('maxSystems'):
        systems = systems[:cfg['maxSystems']]
        keep = sum(systems, [])
        score['measures'] = score['measures'][:len(keep)]
        score['measures'][-1]['barlineRight'] = 'final'

    staff_gap = cfg['staffGapSp'] * sp
    system_gap = cfg['systemGapSp'] * sp
    y = margin + (4 * sp if cfg['title'] else 0) + 3 * sp
    if cfg['title']:
        pg.text(rng.choice(TITLES), W * 0.5 - 6 * sp, margin, 3.2 * sp)

    gt_measures = [None] * len(score['measures'])
    acc_state_note = {}
    for s_idx, m_indices in enumerate(systems):
        staff_tops = [y + i * (4 * sp + staff_gap) for i in range(staff_count)]
        sys_top, sys_bot = staff_tops[0], staff_tops[-1] + 4 * sp
        # staff lines
        for top in staff_tops:
            for i in range(5):
                pg.hline(x_left, x_right, top + i * sp, pg.lt)
        if staff_count == 2:
            pg.vline(x_left, sys_top, sys_bot, pg.lt)
            span = (sys_bot - sys_top) / sp
            pg.glyph('brace', x_left - 1.3 * sp, (sys_top + sys_bot) / 2, yscale=span / 4.1)
        # header per staff
        x_after_header = x_left
        for si, top in enumerate(staff_tops):
            x = x_left + 0.7 * sp
            clef = clefs[si]
            if clef == 'treble':
                pg.glyph('gClef', x, top + 3 * sp)
                x += 2.21 * sp
            elif clef == 'bass':
                pg.glyph('fClef', x, top + 1 * sp)
                x += 2.8 * sp
            else:
                pg.glyph('cClef', x, top + 2 * sp)
                x += 2.75 * sp
            x += 0.8 * sp
            for kind, pos in key_sig_positions(fifths, clef):
                pg.glyph(kind, x + 0.45 * sp, top + pos * sp / 2)
                x += 1.05 * sp
            if fifths:
                x += 0.5 * sp
            if s_idx == 0:
                if cfg['timeSigDisplay'] == 'common':
                    pg.glyph('common', x, top + 2 * sp); x += 2.2 * sp
                else:
                    for digit, base_y in ((time_sig[0], top + 2 * sp), (time_sig[1], top + 4 * sp)):
                        s = str(digit)
                        dw = sum(pg.gr.size_sp('digit' + c)[0] for c in s) * sp
                        xx = x + (1.5 * sp - dw) / 2
                        for c in s:
                            pg.glyph('digit' + c, xx, base_y)
                            xx += pg.gr.size_sp('digit' + c)[0] * sp
                    x += 2.0 * sp
            x_after_header = max(x_after_header, x + 0.6 * sp)
        # distribute measures horizontally (justify)
        total_nat = sum(nat_w[mi] for mi in m_indices)
        avail = x_right - x_after_header
        scale = avail / total_nat if total_nat > 0 else 1
        if s_idx == len(systems) - 1 and scale > 1.6:   # last system: do not stretch absurdly
            scale = 1.6
        x = x_after_header
        sys_gt = {'staves': [], 'measureIndices': list(m_indices)}
        for si, top in enumerate(staff_tops):
            xs = np.linspace(x_left, x_right, 9)
            lines = [[[float(xx), float(top + i * sp)] for xx in xs] for i in range(5)]
            sys_gt['staves'].append({'clef': clefs[si], 'lines': lines,
                                     'bbox': [x_left, top, x_right - x_left, 4 * sp]})
        for mi in m_indices:
            m = score['measures'][mi]
            mw = nat_w[mi] * scale
            m_x0 = x
            gt_m = {'bbox': [m_x0, sys_top, mw, sys_bot - sys_top], 'staves': []}
            for si, top in enumerate(staff_tops):
                events = m['staves'][si]
                extra = 1.3 * sp if m['barlineRight'] != 'single' else 0
                gt_events = render_measure(pg, cfg, events, clefs[si], top, m_x0 + 0.8 * sp, mw - 1.0 * sp - extra, time_sig, rng,
                                           lyrics=(cfg['lyrics'] and si == cfg.get('lyricStaff', staff_count - 1) and (staff_count == 1 or 'lyricStaff' in cfg)))
                gt_m['staves'].append(gt_events)
            x += mw
            # barline
            bl = m['barlineRight']
            thin = max(1.0, 0.16 * sp)
            if bl == 'single':
                pg.vline(x, sys_top, sys_bot, thin)
            elif bl == 'double':
                pg.vline(x - 0.5 * sp, sys_top, sys_bot, thin); pg.vline(x, sys_top, sys_bot, thin)
            elif bl == 'final':
                pg.vline(x - 0.7 * sp, sys_top, sys_bot, thin)
                fill_rect(pg.img, x - 0.5 * sp, sys_top, x, sys_bot)
            elif bl == 'repeat-end':
                pg.vline(x - 0.7 * sp, sys_top, sys_bot, thin)
                fill_rect(pg.img, x - 0.5 * sp, sys_top, x, sys_bot)
                for top in staff_tops:
                    for yy in (top + 1.5 * sp, top + 2.5 * sp):
                        pg.glyph('dot', x - 1.25 * sp, yy)
            gt_m['barlineRight'] = bl
            gt_measures[mi] = gt_m
        gt['systems'].append(sys_gt)
        y = sys_bot + system_gap + (cfg.get('lyricSpaceSp', 2.5) * sp if cfg['lyrics'] else 0)
    gt['measures'] = [m for m in gt_measures if m is not None]
    # crop page height to content
    H = int(min(page_h_guess, y - system_gap + margin))
    pg.img = pg.img[:H]
    gt['height'] = H
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    pg.save(out_png)
    with open(out_json, 'w') as f:
        json.dump(gt, f)
    return gt


def render_measure(pg, cfg, events, clef, top, x0, width, time_sig, rng, lyrics=False):
    """Draw the events of one staff-measure; returns GT events with pixel info."""
    sp = pg.sp
    mid = top + 2 * sp
    widths = [event_width_sp(ev, cfg) * sp for ev in events]
    total = sum(widths) or 1
    k = width / total
    xs, x = [], x0
    for w in widths:
        ww = w * k
        xs.append(x + ww * 0.45 if ww < 2.2 * sp else x + min(ww * 0.4, 1.6 * sp) + 0.2 * sp)
        x += ww
    groups = beam_groups(events, time_sig)
    in_group = {i: gi for gi, g in enumerate(groups) for i in g}
    gt_events = []
    head_info = []   # per event: (cx, cy_list, stem_dir, stem_x, head_w)
    # --- stem directions ------------------------------------------------
    stem_dir = {}
    for gi, g in enumerate(groups):
        poss = [n['pos'] for i in g for n in events[i]['notes']]
        mean = sum(poss) / len(poss)
        stem_dir[gi] = 'down' if mean < 4 else 'up'
    # --- heads, stems, accidentals, dots ---------------------------------
    stems = {}
    for i, ev in enumerate(events):
        cx = xs[i]
        if ev['kind'] == 'rest':
            name = {'whole': 'restWhole', 'half': 'restHalf', 'quarter': 'restQuarter',
                    'eighth': 'rest8th', '16th': 'rest16th', '32nd': 'rest32nd'}[ev['base']]
            gw, gh = pg.gr.size_sp(name)
            bb = pg.glyph(name, cx - gw * sp / 2, mid)
            if ev['dots']:
                pg.glyph('dot', cx + gw * sp / 2 + 0.5 * sp, mid - 0.5 * sp)
            gt_events.append({'kind': 'rest', 'base': ev['base'], 'dots': ev['dots'], 'x': cx, 'bbox': bb})
            continue
        notes = ev['notes']
        poss = [n['pos'] for n in notes]
        if i in in_group:
            d = stem_dir[in_group[i]]
        else:
            far = max(poss, key=lambda p: abs(p - 4))
            d = 'down' if far < 4 else 'up'
        head = {'whole': 'noteheadWhole', 'half': 'noteheadHalf'}.get(ev['base'], 'noteheadBlack')
        hw = pg.gr.size_sp(head)[0] * sp
        # seconds: alternate side of the stem (cluster rule)
        sides = [0] * len(notes)          # 0 = normal side, 1 = flipped
        order = range(len(notes)) if d == 'up' else range(len(notes) - 1, -1, -1)
        prev_pos, prev_side = None, 0
        for j in order:
            p = poss[j]
            if prev_pos is not None and abs(p - prev_pos) == 1 and prev_side == 0:
                sides[j] = 1
            prev_pos, prev_side = p, sides[j]
        stem_x = cx + hw / 2 - pg.stem_w / 2 if d == 'up' else cx - hw / 2 + pg.stem_w / 2
        bbox = None
        pitches = []
        for j, n in enumerate(notes):
            p = n['pos']
            hy = top + p * sp / 2
            hx = cx
            if sides[j]:
                hx = cx + hw if d == 'up' else cx - hw
            # ledger lines
            if p <= -2:
                for lp in range(-2, p - 1, -2):
                    pg.hline(hx - hw / 2 - 0.3 * sp, hx + hw / 2 + 0.3 * sp, top + lp * sp / 2, pg.lt)
            if p >= 10:
                for lp in range(10, p + 1, 2):
                    pg.hline(hx - hw / 2 - 0.3 * sp, hx + hw / 2 + 0.3 * sp, top + lp * sp / 2, pg.lt)
            bb = pg.glyph(head, hx, hy)
            bbox = bb if bbox is None else union_bbox(bbox, bb)
            if n['accidental']:
                ax = cx - hw / 2 - 0.25 * sp
                if n['accidental'] == 'flat':
                    pg.glyph('flat', ax - 0.81 * sp, hy)
                else:
                    gw = pg.gr.size_sp(n['accidental'])[0] * sp
                    pg.glyph(n['accidental'], ax - gw / 2, hy)
            pitches.append(pitch_name(n['step'], n['octave'], n['alter']))
        if ev['dots']:
            for n in notes:
                p = n['pos']
                dy = top + (p if p % 2 else p - 1) * sp / 2     # dots go in the space above a line
                pg.glyph('dot', cx + hw / 2 + 0.55 * sp + (hw if any(sides) and d == 'up' else 0), dy)
        if ev['base'] != 'whole':
            ys_ = [top + p * sp / 2 for p in poss]
            if d == 'up':
                y_head = max(ys_); y_far = min(ys_)
                y_end = y_far - 3.5 * sp
                if y_far > mid + 3 * sp:
                    y_end = min(y_end, mid)    # long stems for notes far below the staff
                stems[i] = (stem_x, y_end, y_head)
            else:
                y_head = min(ys_); y_far = max(ys_)
                y_end = y_far + 3.5 * sp
                if y_far < mid - 3 * sp:
                    y_end = max(y_end, mid)
                stems[i] = (stem_x, y_head, y_end)
        head_info.append((cx, d, stem_x, hw))
        gt_events.append({'kind': 'note', 'base': ev['base'], 'dots': ev['dots'], 'pitches': pitches,
                          'tieStart': ev['tieStart'], 'tieEnd': ev['tieEnd'], 'x': cx, 'bbox': bbox})
    # --- beams ------------------------------------------------------------
    for gi, g in enumerate(groups):
        d = stem_dir[gi]
        first, last = g[0], g[-1]
        x1, x2 = stems[first][0], stems[last][0]
        ends = [stems[i][1] if d == 'up' else stems[i][2] for i in g]
        # beam slope follows the outer notes but stays shallow
        if d == 'up':
            y1, y2 = ends[0], ends[-1]
            slope = max(-0.12, min(0.12, (y2 - y1) / max(1, x2 - x1)))
            if abs(slope * (x2 - x1)) > 1.5 * sp:
                slope = 1.5 * sp / (x2 - x1) * (1 if slope > 0 else -1)
            base_y = min(ends[0], min(e - slope * (stems[i][0] - x1) for i, e in zip(g, ends)))
        else:
            y1, y2 = ends[0], ends[-1]
            slope = max(-0.12, min(0.12, (y2 - y1) / max(1, x2 - x1)))
            if abs(slope * (x2 - x1)) > 1.5 * sp:
                slope = 1.5 * sp / (x2 - x1) * (1 if slope > 0 else -1)
            base_y = max(ends[0], max(e - slope * (stems[i][0] - x1) for i, e in zip(g, ends)))
        beam_y = lambda x: base_y + slope * (x - x1)   # noqa: E731
        # extend stems to the beam
        for i in g:
            sx, ya, yb = stems[i]
            by = beam_y(sx)
            stems[i] = (sx, by, yb) if d == 'up' else (sx, ya, by)
        sgn = 1 if d == 'up' else -1
        levels_of = {i: FLAGS[events[i]['base']] for i in g}
        max_level = max(levels_of.values())
        for level in range(1, max_level + 1):
            off = (level - 1) * (pg.beam_h + 0.25 * sp) * sgn
            # runs of consecutive notes having this level
            run = []
            for idx, i in enumerate(g + [None]):
                if i is not None and levels_of[i] >= level:
                    run.append(i)
                    continue
                if run:
                    if len(run) >= 2:
                        xa, xb = stems[run[0]][0] - pg.stem_w / 2, stems[run[-1]][0] + pg.stem_w / 2
                    else:
                        # beamlet: 1 sp stub pointing into the beat
                        j = run[0]
                        pos_in_group = g.index(j)
                        if pos_in_group == 0:
                            xa, xb = stems[j][0] - pg.stem_w / 2, stems[j][0] + 1.0 * sp
                        else:
                            xa, xb = stems[j][0] - 1.0 * sp, stems[j][0] + pg.stem_w / 2
                    ya, yb = beam_y(xa) + off, beam_y(xb) + off
                    pts = [(xa, ya), (xb, yb), (xb, yb + sgn * pg.beam_h), (xa, ya + sgn * pg.beam_h)]
                    fill_polygon(pg.img, pts)
                    run = []
    # --- stems + flags ----------------------------------------------------
    for i, (sx, ya, yb) in stems.items():
        ev = events[i]
        pg.vline(sx, ya, yb, pg.stem_w)
        if ev['base'] in FLAGS and i not in in_group:
            name = {1: 'flag8th', 2: 'flag16th', 3: 'flag32nd'}[FLAGS[ev['base']]]
            cx, d, stem_x, hw = head_info[len([e for e in events[:i] if e['kind'] == 'note'])]
            if d == 'up':
                pg.glyph(name, sx - pg.stem_w / 2, ya)
            else:
                pg.glyph(name, sx - pg.stem_w / 2, yb, flip_y=True)
    # --- ties ---------------------------------------------------------------
    note_idx = [i for i, ev in enumerate(events) if ev['kind'] == 'note']
    for a, b in zip(note_idx, note_idx[1:]):
        if events[a]['tieStart'] and events[b]['tieEnd']:
            draw_tie(pg, head_info[note_idx.index(a)], head_info[note_idx.index(b)], events[a]['notes'][0]['pos'], top)
    if events and events[-1]['kind'] == 'note' and events[-1]['tieStart']:
        # tie into the next measure: draw an arc towards the barline
        cx, d, stem_x, hw = head_info[-1]
        p = events[-1]['notes'][0]['pos']
        draw_tie_arc(pg, cx + 0.4 * sp, x0 + width + 0.8 * sp, top + p * sp / 2 + (0.75 * sp if d == 'up' else -0.75 * sp), d == 'up')
    if events and events[0]['kind'] == 'note' and events[0]['tieEnd']:
        cx, d, stem_x, hw = head_info[0]
        p = events[0]['notes'][0]['pos']
        draw_tie_arc(pg, x0 - 0.6 * sp, cx - 0.4 * sp, top + p * sp / 2 + (0.75 * sp if d == 'up' else -0.75 * sp), d == 'up')
    # --- lyrics (decoration only) -------------------------------------------
    if lyrics and cfg.get('lyricHook'):          # Korean lyrics with ground truth (korean_lyrics.py)
        cfg['lyricHook'](pg, events, gt_events, xs, top)
    elif lyrics:
        for i, ev in enumerate(events):
            if ev['kind'] == 'note':
                pg.text(rng.choice(LYRIC_SYLLABLES), xs[i] - 0.6 * sp, top + 6.2 * sp, 1.7 * sp)
    return gt_events


def draw_tie(pg, ha, hb, pos, top):
    sp = pg.sp
    cxa, da, _, hwa = ha
    cxb, db, _, hwb = hb
    below = da == 'up'
    y = top + pos * sp / 2 + (0.75 * sp if below else -0.75 * sp)
    draw_tie_arc(pg, cxa + 0.45 * sp, cxb - 0.45 * sp, y, below)


def draw_tie_arc(pg, xa, xb, y, below):
    """Tapered slur/tie: two quadratic arcs offset by the thickness."""
    sp = pg.sp
    if xb - xa < 0.8 * sp:
        return
    sag = min(0.9 * sp, 0.12 * (xb - xa) + 0.3 * sp) * (1 if below else -1)
    n = 24
    outer, inner = [], []
    for k in range(n + 1):
        t = k / n
        x = xa + (xb - xa) * t
        yy = y + sag * 4 * t * (1 - t)
        th = 0.08 * sp + 0.14 * sp * 4 * t * (1 - t)
        outer.append((x, yy)); inner.append((x, yy + (th if below else -th)))
    fill_polygon(pg.img, outer + inner[::-1])


def union_bbox(a, b):
    x0, y0 = min(a[0], b[0]), min(a[1], b[1])
    x1, y1 = max(a[0] + a[2], b[0] + b[2]), max(a[1] + a[3], b[1] + b[3])
    return [x0, y0, x1 - x0, y1 - y0]


# ----------------------------------------------------------------------------
# corpus configurations
# ----------------------------------------------------------------------------
def make_config(rng, idx):
    kind = ['mono', 'mono', 'mono', 'bass', 'piano', 'piano', 'chords', 'mono16', 'alto'][idx % 9]
    W = rng.choice([1200, 1500, 1800, 2100, 2500])
    sp = rng.choice([6, 7, 8, 9, 10, 11, 12, 13, 14, 16])
    if W <= 1200:
        sp = min(sp, 12)
    if W >= 2100:
        sp = max(sp, 9)
    time_sig = pick(rng, [(5, (4, 4)), (3, (3, 4)), (2, (2, 4)), (2, (6, 8))])
    cfg = {
        'pageWidth': W, 'pageHeight': int(W * 1.414), 'sp': sp,
        'marginSp': rng.uniform(4, 7), 'staffGapSp': rng.uniform(6, 8), 'systemGapSp': rng.uniform(7, 11),
        'lineThick': rng.uniform(0.08, 0.14), 'stemThick': rng.uniform(0.1, 0.15), 'beamThick': rng.uniform(0.45, 0.55),
        'spacing': rng.uniform(0.9, 1.2),
        'keyFifths': pick(rng, [(6, 0), (3, 1), (3, -1), (2, 2), (2, -2), (1, 3), (1, -3), (1, 4), (1, -4)]),
        'timeSig': time_sig, 'timeSigDisplay': 'common' if (time_sig == (4, 4) and rng.random() < 0.25) else 'digits',
        'accidentalProb': rng.choice([0.0, 0.08, 0.15]), 'tieProb': rng.choice([0.0, 0.08, 0.15]),
        'chordProb': 0.0, 'style': 'full', 'lyrics': False, 'title': rng.random() < 0.5,
        'measures': 8, 'maxSystems': rng.choice([2, 3, 4]),
    }
    if kind == 'mono':
        cfg.update(staffCount=1, clefs=['treble'], style='simple', lyrics=rng.random() < 0.4)
    elif kind == 'mono16':
        cfg.update(staffCount=1, clefs=['treble'], style='full')
    elif kind == 'bass':
        cfg.update(staffCount=1, clefs=['bass'], style='simple')
    elif kind == 'alto':
        cfg.update(staffCount=1, clefs=['alto'], style='simple')
    elif kind == 'piano':
        cfg.update(staffCount=2, clefs=['treble', 'bass'], chordProb=0.15, style='simple')
    elif kind == 'chords':
        cfg.update(staffCount=1, clefs=['treble'], chordProb=0.4, style='simple')
    cfg['measures'] = 64   # generated; the page is cut to maxSystems systems
    cfg['name'] = f'{idx:03d}_{kind}_sp{sp}_w{W}'
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), 'corpus'))
    ap.add_argument('--count', type=int, default=40)
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--only', type=int, default=None)
    args = ap.parse_args()
    base_dir = os.path.join(args.out, 'base')
    os.makedirs(base_dir, exist_ok=True)
    for i in range(args.count):
        if args.only is not None and i != args.only:
            continue
        rng = random.Random(args.seed * 1000 + i)
        cfg = make_config(rng, i)
        png = os.path.join(base_dir, cfg['name'] + '.png')
        gt = render_page(rng, cfg, png, png[:-4] + '.json')
        n_notes = sum(1 for m in gt['measures'] for s in m['staves'] for e in s if e['kind'] == 'note')
        print(f"{cfg['name']}: {gt['width']}x{gt['height']} systems={len(gt['systems'])} measures={len(gt['measures'])} notes={n_notes}")


if __name__ == '__main__':
    main()
