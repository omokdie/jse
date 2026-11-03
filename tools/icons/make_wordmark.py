#!/usr/bin/env python3
"""Builds the JSE app icon: the JSE wordmark (Inter Display ExtraBold, outlined to paths)
spanning a five-line staff on a blue→violet glass squircle. Writes tools/icons/app-icon.svg
and prints the small in-app logo SVG to tools/icons/logo-inline.svg."""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

FONT = '/usr/share/fonts/opentype/inter/InterDisplay-ExtraBold.otf'
f = TTFont(FONT); gs = f.getGlyphSet(); cmap = f.getBestCmap()
TEXT = 'JSE'
CAP = 236.0                       # cap height in icon px: letters stand on the bottom line, the top line stays visible
TRACK = -6                       # tighter tracking for a logotype
STAFF_Y = [372, 442, 512, 582, 652]

b = BoundsPen(gs); gs[cmap[ord('E')]].draw(b); cap_units = b.bounds[3]
scale = CAP / cap_units
# measure total width with tracking
names = [cmap[ord(c)] for c in TEXT]
adv = [gs[n].width * scale for n in names]
lsb = []; boxes = []
for n in names:
    bp = BoundsPen(gs); gs[n].draw(bp); boxes.append(bp.bounds)
ink_left = boxes[0][0] * scale
total = sum(adv[:-1]) + TRACK * (len(names) - 1) + boxes[-1][2] * scale - ink_left
x0 = 512 - total / 2 - ink_left
baseline = STAFF_Y[-1] + 6        # letters stand on the bottom staff line
paths = []
x = x0
for n, a in zip(names, adv):
    sp = SVGPathPen(gs, ntos=lambda v: ('%.1f' % v).rstrip('0').rstrip('.'))
    tp = TransformPen(sp, (scale, 0, 0, -scale, x, baseline))
    gs[n].draw(tp)
    paths.append(sp.getCommands())
    x += a + TRACK
letters = ' '.join(paths)

def icon(filters=True, rim=True):
    sh = ' filter="url(#sh)"' if filters else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="120" y1="40" x2="900" y2="1000"><stop offset="0" stop-color="#3fb3ff"/><stop offset=".5" stop-color="#0a6cff"/><stop offset="1" stop-color="#5b4bea"/></linearGradient>
    <radialGradient id="glow" gradientUnits="userSpaceOnUse" cx="260" cy="120" r="760"><stop offset="0" stop-color="#fff" stop-opacity=".42"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="0" y1="360" x2="0" y2="660"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e3ecff"/></linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset=".5" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-color="#fff" stop-opacity=".5"/></linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="14" stdDeviation="16" flood-color="#0b1a5c" flood-opacity=".35"/></filter>
  </defs>
  <rect width="1024" height="1024" rx="232" fill="url(#bg)"/>
  <g stroke="#fff" stroke-opacity=".5" stroke-width="12" stroke-linecap="round">{''.join(f'<line x1="104" y1="{y}" x2="920" y2="{y}"/>' for y in STAFF_Y)}</g>
  <path d="{letters}" fill="url(#bg)" stroke="url(#bg)" stroke-width="40" stroke-linejoin="round"/>
  <rect width="1024" height="1024" rx="232" fill="url(#glow)"/>
  <path d="{letters}" fill="url(#ink)"{sh}/>
  {'<rect x="5" y="5" width="1014" height="1014" rx="228" fill="none" stroke="url(#rim)" stroke-width="10"/>' if rim else ''}
</svg>
'''
open('tools/icons/app-icon.svg', 'w').write(icon(True))
inline = icon(False, True).replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">', '<svg viewBox="0 0 1024 1024" aria-hidden="true">')
# unique ids for the in-page copy
for i in ['bg', 'glow', 'ink', 'rim', 'sh']:
    inline = inline.replace(f'id="{i}"', f'id="jse-{i}"').replace(f'url(#{i})', f'url(#jse-{i})')
open('tools/icons/logo-inline.svg', 'w').write(' '.join(inline.split()))
print('scale', round(scale, 4), 'total width', round(total, 1))
