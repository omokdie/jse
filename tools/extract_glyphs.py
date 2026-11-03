#!/usr/bin/env python3
"""Extract music glyph outlines from GNU FreeSerif (GPLv3 + font exception)
into an ES module used by the JSE engraver.

Coordinate system of the output: 1 unit = 1 staff space, y grows downward.
Each glyph is re-anchored so that (0,0) is the point the engraver positions.
"""
import json, re, sys
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

SERIF = '/usr/share/fonts/truetype/freefont/FreeSerif.ttf'
BOLD = '/usr/share/fonts/truetype/freefont/FreeSerifBold.ttf'
UPS = 191.0  # font units per staff space (measured from U+1D11A five-line staff: 764/4)
LINE_Y = [-12, 179, 370, 561, 752]  # centres of staff lines 5..1 (bottom→top) in font units

fs = TTFont(SERIF); cmap = fs.getBestCmap(); gs = fs.getGlyphSet()
fb = TTFont(BOLD); cmapb = fb.getBestCmap(); gsb = fb.getGlyphSet()

def contours(glyphset, name):
    rp = DecomposingRecordingPen(glyphset); glyphset[name].draw(rp)
    out, cur = [], []
    for op, args in rp.value:
        if op == 'moveTo' and cur:
            out.append(cur); cur = []
        cur.append((op, args))
        if op in ('closePath', 'endPath'):
            out.append(cur); cur = []
    if cur: out.append(cur)
    return out

def contour_bounds(c):
    bp = BoundsPen(None)
    for op, args in c: getattr(bp, op)(*args)
    return bp.bounds

def strip_dotted_circle(cs):
    """Combining glyphs in FreeSerif carry a dotted circle made of many tiny
    identical contours; drop any cluster of >=8 small identical contours."""
    info = []
    for c in cs:
        b = contour_bounds(c)
        if b is None: continue
        w, h = b[2]-b[0], b[3]-b[1]
        info.append((c, b, round(w), round(h)))
    from collections import Counter
    sizes = Counter((w, h) for _, _, w, h in info)
    keep = []
    for c, b, w, h in info:
        if sizes[(w, h)] >= 8 and w < 60 and h < 60:
            continue
        keep.append((c, b))
    return keep

def to_path(kept, anchor_x, anchor_y, scale=1.0, flip_x=False, flip_y=False):
    sp = SVGPathPen(None, ntos=lambda v: ('%.3f' % v).rstrip('0').rstrip('.') if abs(v) > 1e-9 else '0')
    sx = scale / UPS * (-1 if flip_x else 1)
    sy = -scale / UPS * (-1 if flip_y else 1)
    tp = TransformPen(sp, (sx, 0, 0, sy, -anchor_x * sx, -anchor_y * sy))
    for c, _ in kept:
        for op, args in c:
            getattr(tp, op)(*args)
    d = sp.getCommands()
    return d

def bbox_of(kept, anchor_x, anchor_y, scale=1.0, flip_x=False, flip_y=False):
    xs0, ys0, xs1, ys1 = [], [], [], []
    for _, b in kept:
        xs0.append(b[0]); ys0.append(b[1]); xs1.append(b[2]); ys1.append(b[3])
    x0, y0, x1, y1 = min(xs0), min(ys0), max(xs1), max(ys1)
    def tx(x): return ((-(x) if flip_x else x) - (-(anchor_x) if flip_x else anchor_x)) * scale / UPS
    def ty(y): return -(((-(y) if flip_y else y) - (-(anchor_y) if flip_y else anchor_y)) * scale / UPS)
    X = sorted([tx(x0), tx(x1)]); Y = sorted([ty(y0), ty(y1)])
    return [round(X[0], 3), round(Y[0], 3), round(X[1], 3), round(Y[1], 3)]

# anchor spec: ('bbox-center' | 'left-center' | ('abs', x, y) | 'bottom-center' | 'top-center' | 'baseline-left' | 'inner-center')
def anchor_point(kept, spec):
    xs0, ys0, xs1, ys1 = [], [], [], []
    for _, b in kept:
        xs0.append(b[0]); ys0.append(b[1]); xs1.append(b[2]); ys1.append(b[3])
    x0, y0, x1, y1 = min(xs0), min(ys0), max(xs1), max(ys1)
    if spec == 'bbox-center': return ((x0+x1)/2, (y0+y1)/2)
    if spec == 'left-center': return (x0, (y0+y1)/2)
    if spec == 'bottom-center': return ((x0+x1)/2, y0)
    if spec == 'top-center': return ((x0+x1)/2, y1)
    if spec == 'baseline-left': return (x0, 0)
    if spec == 'left-top': return (x0, y1)
    if spec == 'inner-center':
        # centre of the smallest contour (the counter of a flat's loop)
        small = min(kept, key=lambda kb: (kb[1][2]-kb[1][0])*(kb[1][3]-kb[1][1]))
        b = small[1]; return (x0, (b[1]+b[3])/2)
    if isinstance(spec, tuple) and spec[0] == 'abs': return (spec[1], spec[2])
    if isinstance(spec, tuple) and spec[0] == 'left-y': return (x0, spec[1])
    raise ValueError(spec)

GLYPHS = {
    # name: (codepoint, anchor, options)
    'gClef': (0x1D11E, ('left-y', LINE_Y[1])),
    'gClef8vb': (0x1D120, ('left-y', LINE_Y[1])),
    'gClef8va': (0x1D11F, ('left-y', LINE_Y[1])),
    'fClef': (0x1D122, ('left-y', LINE_Y[3])),
    'fClef8vb': (0x1D124, ('left-y', LINE_Y[3])),
    'cClef': (0x1D121, ('left-y', LINE_Y[2])),
    'percClef': (0x1D125, ('left-y', LINE_Y[2])),
    'tabClef': None,  # drawn as text
    'noteheadBlack': (0x1D158, 'left-center'),
    'noteheadHalf': (0x1D157, 'left-center'),
    'noteheadWhole': (0x1D15D, 'left-center'),
    'noteheadDoubleWhole': (0x1D15C, 'left-center'),
    'noteheadX': (0x1D143, 'left-center'),
    'noteheadCircleX': (0x1D145, 'left-center'),
    'noteheadPlus': (0x1D144, 'left-center'),
    'noteheadDiamondWhite': (0x1D154, 'left-center'),
    'noteheadDiamondBlack': (0x1D155, 'left-center'),
    'noteheadTriangleUpWhite': (0x1D148, 'left-center'),
    'noteheadTriangleUpBlack': (0x1D149, 'left-center'),
    'noteheadTriangleDownWhite': (0x1D14E, 'left-center'),
    'noteheadTriangleDownBlack': (0x1D14F, 'left-center'),
    'noteheadSquareWhite': (0x1D146, 'left-center'),
    'noteheadSquareBlack': (0x1D147, 'left-center'),
    'noteheadSlash': (0x1D10D, 'left-center'),
    'accidentalSharp': (0x266F, 'left-center', 0.56),
    'accidentalFlat': (0x266D, 'inner-center', 0.57),
    'accidentalNatural': (0x266E, 'left-center', 0.54),
    'accidentalDoubleSharp': (0x1D12A, 'left-center', 0.52),
    'accidentalDoubleFlat': (0x1D12B, 'inner-center', 0.57),
    'restDoubleWhole': (0x1D13A, ('left-y', LINE_Y[2])),
    'restWhole': (0x1D13B, ('left-y', LINE_Y[2])),
    'restHalf': (0x1D13C, ('left-y', LINE_Y[2])),
    'restQuarter': (0x1D13D, ('left-y', LINE_Y[2])),
    'rest8th': (0x1D13E, ('left-y', LINE_Y[2])),
    'rest16th': (0x1D13F, ('left-y', LINE_Y[2])),
    'rest32nd': (0x1D140, ('left-y', LINE_Y[2])),
    'rest64th': (0x1D141, ('left-y', LINE_Y[2])),
    'rest128th': (0x1D142, ('left-y', LINE_Y[2])),
    'restHBar': (0x1D129, ('left-y', LINE_Y[2])),
    'flag8thUp': (0x1D16E, 'left-top'),
    'flag16thUp': (0x1D16F, 'left-top'),
    'flag32ndUp': (0x1D170, 'left-top'),
    'flag64thUp': (0x1D171, 'left-top'),
    'flag128thUp': (0x1D172, 'left-top'),
    'articAccent': (0x1D17B, 'bbox-center'),
    'articStaccato': (0x1D17C, 'bbox-center'),
    'articTenuto': (0x1D17D, 'bbox-center'),
    'articStaccatissimo': (0x1D17E, 'bbox-center'),
    'articMarcato': (0x1D17F, 'bbox-center'),
    'articMarcatoStaccato': (0x1D180, 'bbox-center'),
    'articAccentStaccato': (0x1D181, 'bbox-center'),
    'articTenutoStaccato': (0x1D182, 'bbox-center'),
    'fermataAbove': (0x1D110, 'bottom-center'),
    'fermataBelow': (0x1D111, 'top-center'),
    'breathMark': (0x1D112, 'bottom-center'),
    'caesura': (0x1D113, 'bottom-center'),
    'dynamicPiano': (0x1D18F, 'baseline-left', 0.78),
    'dynamicMezzo': (0x1D190, 'baseline-left', 0.78),
    'dynamicForte': (0x1D191, 'baseline-left', 0.78),
    'dynamicRinforzando': (0x1D18C, 'baseline-left', 0.78),
    'dynamicSforzando': (0x1D18D, 'baseline-left', 0.78),
    'dynamicZ': (0x1D18E, 'baseline-left', 0.78),
    'ornamentTrill': (0x1D196, 'baseline-left', 0.85),
    'ornamentTurn': (0x1D197, 'bbox-center'),
    'ornamentTurnInverted': (0x1D198, 'bbox-center'),
    'ornamentTurnSlash': (0x1D199, 'bbox-center'),
    'ornamentMordent': (0x1D19D, 'bbox-center'),
    'ornamentShortTrill': (0x1D19C, 'bbox-center'),
    'segno': (0x1D10B, 'bottom-center'),
    'coda': (0x1D10C, 'bottom-center'),
    'ottavaAlta': (0x1D136, 'baseline-left'),
    'ottavaBassa': (0x1D137, 'baseline-left'),
    'quindicesimaAlta': (0x1D138, 'baseline-left'),
    'quindicesimaBassa': (0x1D139, 'baseline-left'),
    'keyboardPedalPed': (0x1D1AE, 'baseline-left'),
    'keyboardPedalUp': (0x1D1AF, 'bbox-center'),
    'brace': (0x1D114, ('left-y', LINE_Y[2])),
    'bracket': (0x1D115, ('left-y', LINE_Y[2])),
    'timeSigCommon': (0x1D134, ('left-y', LINE_Y[2])),
    'timeSigCutCommon': (0x1D135, ('left-y', LINE_Y[2])),
    'repeatDots': (0x1D108, ('left-y', LINE_Y[2])),
    'arpeggiato': (0x1D183, 'top-center'),
    'glissandoWavy': (0x1D1B1, 'left-center'),
    'tremolo1': (0x1D167, 'bbox-center'),
    'tremolo2': (0x1D168, 'bbox-center'),
    'tremolo3': (0x1D169, 'bbox-center'),
    'stringsUpBow': (0x1D1AB, 'bbox-center'),
    'stringsDownBow': (0x1D1AA, 'bbox-center'),
    'augmentationDot': (0x1D16D, 'bbox-center'),
    'noteheadParenthesisLeft': None,
    'pluckedSnapPizzicato': (0x1D1AD, 'bbox-center'),
    'harmonicNatural': (0x1D1AC, 'bbox-center'),
}

out = {}
for name, spec in GLYPHS.items():
    if spec is None: continue
    cp, anchor = spec[0], spec[1]
    gscale = spec[2] if len(spec) > 2 else 1.0
    if cp not in cmap:
        print('missing', name, hex(cp), file=sys.stderr); continue
    cs = contours(gs, cmap[cp])
    kept = strip_dotted_circle(cs)
    if not kept:
        print('empty', name, file=sys.stderr); continue
    ax, ay = anchor_point(kept, anchor)
    d = to_path(kept, ax, ay, scale=gscale)
    bb = bbox_of(kept, ax, ay, scale=gscale)
    adv = round((gs[cmap[cp]].width - ax) * gscale / UPS, 3)
    out[name] = {'p': d, 'b': bb, 'w': round(bb[2] - bb[0], 3), 'adv': adv}
    # mirrored flags for stem-down
    if name.endswith('Up') and name.startswith('flag'):
        kept2 = kept
        axd, ayd = anchor_point(kept2, 'left-top')
        # mirror vertically around anchor: we flip y, anchor at top becomes bottom
        dd = to_path(kept2, axd, ayd, flip_y=True)
        bbd = bbox_of(kept2, axd, ayd, flip_y=True)
        out[name[:-2] + 'Down'] = {'p': dd, 'b': bbd, 'w': round(bbd[2]-bbd[0], 3)}

# Digits & a few symbols from FreeSerif Bold, scaled so digit height == 2 staff spaces (time signatures)
digit_h = None
bp = BoundsPen(gsb); gsb[cmapb[ord('0')]].draw(bp); digit_h = bp.bounds[3] - bp.bounds[1]
dscale = 2.0 * UPS / digit_h
for ch in '0123456789+()':
    cp = ord(ch)
    cs = contours(gsb, cmapb[cp])
    kept = [(c, contour_bounds(c)) for c in cs if contour_bounds(c)]
    d = to_path(kept, 0, 0, scale=dscale)
    bb = bbox_of(kept, 0, 0, scale=dscale)
    out['tsDigit' + (ch if ch.isdigit() else {'+':'Plus','(':'ParenL',')':'ParenR'}[ch])] = {
        'p': d, 'b': bb, 'w': round(gsb[cmapb[cp]].width * dscale / UPS, 3)}

js = "// Music glyph outlines extracted from GNU FreeSerif (GPLv3 with font exception).\n" \
     "// See fonts/LICENSE-FreeFont.txt. Units: 1 = one staff space, y grows downward.\n" \
     "export const GLYPHS = " + json.dumps(out, separators=(',', ':')) + ";\n" \
     "export function glyph(name) { const g = GLYPHS[name]; if (!g) throw new Error('unknown glyph ' + name); return g; }\n"
import os
os.makedirs('/home/claude/scoresnap/app/js/engrave', exist_ok=True)
open('/home/claude/scoresnap/app/js/engrave/glyphs.js', 'w').write(js)
print('glyphs:', len(out), 'bytes:', len(js))
for k in ['gClef','fClef','noteheadBlack','accidentalFlat','accidentalSharp','flag8thUp','flag8thDown','restQuarter','articStaccato','tsDigit4','dynamicForte']:
    print(k, out[k]['b'], out[k]['w'])
