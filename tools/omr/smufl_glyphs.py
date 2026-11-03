#!/usr/bin/env python3
"""Alternate engraver glyph tables from SMuFL music fonts — for the OMR
training / evaluation page generator ONLY (tools/omr/gen_finale_pages.mjs);
nothing here is shipped with the app.

The output has the same format as app/js/engrave/glyphs.js (1 unit = 1 staff
space, y down, {p: svg path, b: bbox, w: width, adv}) and the same anchor
conventions as the FreeSerif table, so that `Object.assign(GLYPHS, table)`
re-skins the engraver: SMuFL glyph origins already are the engraver anchors
(notehead left/centre, accidental pitch line, clef reference line, flag stem
end), except whole rests (hang from the line above the middle line), time
signature digits (bottom on the anchor) and centred marks.

  git clone --depth 1 https://github.com/steinbergmedia/bravura /tmp/fonts/bravura   (SIL OFL)
  python3 tools/omr/smufl_glyphs.py --font /tmp/fonts/bravura/redist/otf/Bravura.otf --out /tmp/omr_fonts/bravura.json
"""
import argparse, json, os
from fontTools.ttLib import TTFont
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

# engraver name -> (SMuFL codepoint, placement rule)
#   'origin'   : SMuFL origin = engraver anchor
#   'wholeRest': origin moved one staff space up (hangs from line 2)
#   'digit'    : bottom of the digit on the anchor, left edge at 0
#   'center'   : bbox centre on the anchor
#   'bottomC'  : horizontal centre, bottom on the anchor
#   'topC'     : horizontal centre, top on the anchor
MAP = {
    'gClef': (0xE050, 'origin'), 'gClef8vb': (0xE052, 'origin'), 'gClef8va': (0xE053, 'origin'),
    'fClef': (0xE062, 'origin'), 'fClef8vb': (0xE064, 'origin'), 'cClef': (0xE05C, 'origin'),
    'noteheadBlack': (0xE0A4, 'origin'), 'noteheadHalf': (0xE0A3, 'origin'), 'noteheadWhole': (0xE0A2, 'origin'),
    'noteheadDoubleWhole': (0xE0A0, 'origin'),
    'accidentalSharp': (0xE262, 'origin'), 'accidentalFlat': (0xE260, 'origin'), 'accidentalNatural': (0xE261, 'origin'),
    'accidentalDoubleSharp': (0xE263, 'origin'), 'accidentalDoubleFlat': (0xE264, 'origin'),
    'restDoubleWhole': (0xE4E2, 'origin'), 'restWhole': (0xE4E3, 'wholeRest'), 'restHalf': (0xE4E4, 'origin'),
    'restQuarter': (0xE4E5, 'origin'), 'rest8th': (0xE4E6, 'origin'), 'rest16th': (0xE4E7, 'origin'),
    'rest32nd': (0xE4E8, 'origin'), 'rest64th': (0xE4E9, 'origin'), 'rest128th': (0xE4EA, 'origin'),
    'flag8thUp': (0xE240, 'origin'), 'flag8thDown': (0xE241, 'origin'), 'flag16thUp': (0xE242, 'origin'),
    'flag16thDown': (0xE243, 'origin'), 'flag32ndUp': (0xE244, 'origin'), 'flag32ndDown': (0xE245, 'origin'),
    'flag64thUp': (0xE246, 'origin'), 'flag64thDown': (0xE247, 'origin'), 'flag128thUp': (0xE248, 'origin'),
    'flag128thDown': (0xE249, 'origin'),
    'articAccent': (0xE4A0, 'center'), 'articStaccato': (0xE4A2, 'center'), 'articTenuto': (0xE4A4, 'center'),
    'articStaccatissimo': (0xE4A6, 'center'), 'articMarcato': (0xE4AC, 'center'),
    'fermataAbove': (0xE4C0, 'bottomC'), 'fermataBelow': (0xE4C1, 'topC'),
    'dynamicPiano': (0xE520, 'origin'), 'dynamicMezzo': (0xE521, 'origin'), 'dynamicForte': (0xE522, 'origin'),
    'dynamicRinforzando': (0xE523, 'origin'), 'dynamicSforzando': (0xE524, 'origin'), 'dynamicZ': (0xE525, 'origin'),
    'ornamentTrill': (0xE566, 'origin'), 'ornamentTurn': (0xE567, 'center'), 'ornamentMordent': (0xE56D, 'center'),
    'ornamentShortTrill': (0xE56C, 'center'),
    'segno': (0xE047, 'bottomC'), 'coda': (0xE048, 'bottomC'),
    'timeSigCommon': (0xE08A, 'origin'), 'timeSigCutCommon': (0xE08B, 'origin'),
    'augmentationDot': (0xE1E7, 'center'),
    'keyboardPedalPed': (0xE650, 'origin'), 'keyboardPedalUp': (0xE655, 'center'),
}
for _d in range(10):
    MAP['tsDigit%d' % _d] = (0xE080 + _d, 'digit')


def build(font_path):
    f = TTFont(font_path)
    ups = f['head'].unitsPerEm / 4.0          # SMuFL: 1 em = 4 staff spaces
    cmap = f.getBestCmap()
    gs = f.getGlyphSet()
    hmtx = f['hmtx']
    out = {}
    nd = lambda v: ('%.3f' % v).rstrip('0').rstrip('.') if abs(v) > 1e-9 else '0'
    for name, (cp, rule) in MAP.items():
        if cp not in cmap:
            continue
        gname = cmap[cp]
        bp = BoundsPen(gs)
        gs[gname].draw(bp)
        if bp.bounds is None:
            continue
        x0, y0, x1, y1 = [v / ups for v in bp.bounds]      # y up
        # y-down bbox before translation
        X0, X1, Y0, Y1 = x0, x1, -y1, -y0
        dx = dy = 0.0
        k = 1.0                               # extra scale: digits are normalised to 2 sp height
        if rule == 'digit' and Y1 - Y0 > 2.2:
            k = 2.0 / (Y1 - Y0)
            X0, X1, Y0, Y1 = X0 * k, X1 * k, Y0 * k, Y1 * k
        if rule == 'wholeRest':
            dy = -1.0
        elif rule == 'digit':
            dy = -Y1
        elif rule == 'center':
            dx, dy = -(X0 + X1) / 2, -(Y0 + Y1) / 2
        elif rule == 'bottomC':
            dx, dy = -(X0 + X1) / 2, -Y1
        elif rule == 'topC':
            dx, dy = -(X0 + X1) / 2, -Y0
        sp = SVGPathPen(None, ntos=nd)
        s = k / ups
        tp = TransformPen(sp, (s, 0, 0, -s, dx, dy))
        rp = DecomposingRecordingPen(gs)
        gs[gname].draw(rp)
        rp.replay(tp)
        b = [round(X0 + dx, 3), round(Y0 + dy, 3), round(X1 + dx, 3), round(Y1 + dy, 3)]
        adv = round(hmtx[gname][0] * k / ups + dx, 3)
        w = round(b[2] - b[0], 3)
        if rule == 'digit':
            w = round(max(hmtx[gname][0] * k / ups, b[2]), 3)
        out[name] = {'p': sp.getCommands(), 'b': b, 'w': w, 'adv': adv}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--font', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    t = build(a.font)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(t, open(a.out, 'w'), separators=(',', ':'))
    print(os.path.basename(a.font), len(t), 'glyphs;', {k: t[k]['b'] for k in ('noteheadBlack', 'accidentalSharp', 'restWhole', 'tsDigit4', 'gClef') if k in t})


if __name__ == '__main__':
    main()
