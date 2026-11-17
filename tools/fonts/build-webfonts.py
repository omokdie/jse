#!/usr/bin/env python3
"""Builds app/fonts/web/ — the "JSE 글꼴" that the app downloads on demand.

    python3 -I tools/fonts/build-webfonts.py --src <google/fonts checkout>/ofl [--out app/fonts/web]

Get the sources with
    git clone --depth 1 --filter=blob:none --sparse https://github.com/google/fonts.git gf
    cd gf && git sparse-checkout set ofl/nanummyeongjo ofl/gowunbatang ofl/nanumgothic ofl/gowundodum \
        ofl/nanumpenscript ofl/oldstandardtt ofl/libertinusserif

Every font is shipped UNMODIFIED: the original TrueType file is only wrapped into a WOFF 1.0
container (per-table zlib, no metadata block, no private block). Nothing is subset, renamed,
re-hinted or re-compiled, so the Reserved Font Names of the OFL stay respected (OFL-FAQ 2.2:
a WOFF made this way is not a Modified Version). The script proves it for each file: the WOFF
is decoded again and must give back the original file bit for bit (same SHA-256), and fontTools
must read identical raw table data from both.

Writes   <out>/<family dir>/<File>.woff, <out>/<family dir>/OFL.txt, <out>/manifest.json
and prints the catalogue that app/js/fonts.js embeds (tools/tests/textstyles.test.js checks
that the two stay in sync).
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import zlib

# family dir in google/fonts, CSS family (= the font's own family name), Korean display name,
# category, weight → file
FONTS = [
    ('nanummyeongjo', 'Nanum Myeongjo', '나눔명조', 'serif-ko', {400: 'NanumMyeongjo-Regular.ttf', 700: 'NanumMyeongjo-Bold.ttf'}),
    ('gowunbatang', 'Gowun Batang', '고운바탕', 'serif-ko', {400: 'GowunBatang-Regular.ttf', 700: 'GowunBatang-Bold.ttf'}),
    ('nanumgothic', 'Nanum Gothic', '나눔고딕', 'sans-ko', {400: 'NanumGothic-Regular.ttf', 700: 'NanumGothic-Bold.ttf'}),
    ('gowundodum', 'Gowun Dodum', '고운돋움', 'sans-ko', {400: 'GowunDodum-Regular.ttf'}),
    ('nanumpenscript', 'Nanum Pen Script', '나눔손글씨 펜', 'hand-ko', {400: 'NanumPenScript-Regular.ttf'}),
    ('oldstandardtt', 'Old Standard TT', '올드 스탠더드', 'serif-latin', {400: 'OldStandard-Regular.ttf', 700: 'OldStandard-Bold.ttf'}),
    ('libertinusserif', 'Libertinus Serif', '리베르티누스 세리프', 'serif-latin', {400: 'LibertinusSerif-Regular.ttf', 700: 'LibertinusSerif-Bold.ttf'}),
]


def pad4(n):
    return (n + 3) & ~3


def sfnt_tables(data):
    """[(tag, checksum, offset, length)] in directory order."""
    flavor, num = struct.unpack('>4sH', data[:6])
    if flavor not in (b'\x00\x01\x00\x00', b'OTTO', b'true'):
        raise ValueError('not a TrueType/OpenType file')
    return flavor, [struct.unpack('>4sIII', data[12 + 16 * i: 28 + 16 * i]) for i in range(num)]


def wrap_woff(data):
    """Lossless WOFF 1.0 wrap: table bytes untouched, data blocks in the original order."""
    flavor, tables = sfnt_tables(data)
    num = len(tables)
    by_offset = sorted(tables, key=lambda t: t[2])
    blocks, entries = [], {}
    pos = 44 + 20 * num
    for tag, checksum, offset, length in by_offset:
        raw = data[offset:offset + length]
        comp = zlib.compress(raw, 9)
        if len(comp) >= length:
            comp = raw                      # WOFF: store as is when compression does not help
        entries[tag] = (pos, len(comp), length, checksum)
        blocks.append(comp + b'\0' * (pad4(len(comp)) - len(comp)))
        pos += pad4(len(comp))
    total_sfnt = 12 + 16 * num + sum(pad4(t[3]) for t in tables)
    head_off = next(t[2] for t in tables if t[0] == b'head')
    major, minor = struct.unpack('>HH', data[head_off + 4:head_off + 8])   # fontRevision 16.16
    header = struct.pack('>4s4sIHHIHHIIIII', b'wOFF', flavor, pos, num, 0, total_sfnt, major, minor, 0, 0, 0, 0, 0)
    directory = b''.join(struct.pack('>4sIIII', tag, *entries[tag]) for tag in sorted(entries))
    out = header + directory + b''.join(blocks)
    assert len(out) == pos
    return out


def unwrap_woff(woff):
    """Reference WOFF 1.0 decoder (spec §"reconstructing the sfnt")."""
    sig, flavor, length, num, _res, total, _maj, _min, mo, ml, mol, po, pl = struct.unpack('>4s4sIHHIHHIIIII', woff[:44])
    assert sig == b'wOFF' and length == len(woff) and (mo, ml, mol, po, pl) == (0, 0, 0, 0, 0)
    ents = [struct.unpack('>4sIIII', woff[44 + 20 * i: 64 + 20 * i]) for i in range(num)]
    es = max(k for k in range(16) if (1 << k) <= num)
    sr = (1 << es) * 16
    out = bytearray(struct.pack('>4sHHHH', flavor, num, sr, es, num * 16 - sr))
    off = 12 + 16 * num
    place = {}
    for tag, woff_off, comp_len, orig_len, checksum in sorted(ents, key=lambda e: e[1]):
        place[tag] = off
        off += pad4(orig_len)
    body = bytearray(off - (12 + 16 * num))
    for tag, woff_off, comp_len, orig_len, checksum in ents:
        raw = woff[woff_off:woff_off + comp_len]
        if comp_len != orig_len:
            raw = zlib.decompress(raw)
        assert len(raw) == orig_len
        out += struct.pack('>4sIII', tag, checksum, place[tag], orig_len)
        at = place[tag] - (12 + 16 * num)
        body[at:at + orig_len] = raw
    assert off == total
    return bytes(out + body)


def name_of(font, name_id):
    rec = font['name'].getDebugName(name_id)
    return rec.strip() if rec else ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', required=True, help='the ofl/ folder of a google/fonts checkout')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'app', 'fonts', 'web'))
    ap.add_argument('--source-commit', default='', help='google/fonts commit the files came from (recorded in the manifest)')
    args = ap.parse_args()
    from fontTools.ttLib import TTFont

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    fonts, total = [], 0
    for folder, family, ko, category, files in FONTS:
        src_dir = os.path.join(args.src, folder)
        dst_dir = os.path.join(out, folder)
        os.makedirs(dst_dir, exist_ok=True)
        shutil.copyfile(os.path.join(src_dir, 'OFL.txt'), os.path.join(dst_dir, 'OFL.txt'))
        meta = open(os.path.join(src_dir, 'METADATA.pb'), encoding='utf-8').read()
        published = re.search(r'^name:\s*"([^"]+)"', meta, re.M).group(1)
        if published != family:
            raise SystemExit(f'{folder}: published as "{published}", expected "{family}"')
        if not re.search(r'^license:\s*"OFL"', meta, re.M):
            raise SystemExit(f'{folder}: not an OFL font')
        entry = {'family': family, 'ko': ko, 'category': category, 'license': 'OFL-1.1', 'licenseFile': f'{folder}/OFL.txt', 'files': {}}
        for weight, ttf_name in sorted(files.items()):
            ttf_path = os.path.join(src_dir, ttf_name)
            data = open(ttf_path, 'rb').read()
            woff = wrap_woff(data)
            # 1. bit-exact round trip
            back = unwrap_woff(woff)
            if back != data:
                raise SystemExit(f'{ttf_name}: WOFF round trip is not bit-identical — refusing to ship it')
            woff_name = os.path.splitext(ttf_name)[0] + '.woff'
            woff_path = os.path.join(dst_dir, woff_name)
            with open(woff_path, 'wb') as f:
                f.write(woff)
            # 2. independent check with fontTools: same tables, same raw bytes, same family name
            a, b = TTFont(ttf_path, lazy=True), TTFont(woff_path, lazy=True)
            assert b.flavor == 'woff' and sorted(a.keys()) == sorted(b.keys()), ttf_name
            for tag in a.reader.keys():
                assert a.reader[tag] == b.reader[tag], f'{ttf_name}: table {tag} differs'
            if 'copyright' not in entry:
                # `family` is the name the font is published under (google/fonts METADATA.pb) and the CSS
                # family JSE registers it with; `fontName` is the family name inside the (untouched) file.
                entry['fontName'] = name_of(b, 16) or name_of(b, 1)
                entry['copyright'] = name_of(b, 0)
                entry['version'] = name_of(b, 5)
            entry['files'][str(weight)] = {
                'file': f'{folder}/{woff_name}', 'bytes': len(woff),
                'sha256': hashlib.sha256(woff).hexdigest(),
                'source': ttf_name, 'sourceBytes': len(data), 'sourceSha256': hashlib.sha256(data).hexdigest(),
            }
            total += len(woff)
            print(f'  {woff_name:34} {len(data):>9} → {len(woff):>9} bytes  (lossless: decoded file == original)', file=sys.stderr)
        fonts.append(entry)
    manifest = {
        'version': 1,
        'note': 'JSE 글꼴 — downloaded on demand by app/js/fonts.js. Unmodified fonts in a lossless WOFF 1.0 wrap; see tools/fonts/README.md.',
        'source': 'https://github.com/google/fonts' + (f' @ {args.source_commit}' if args.source_commit else ''),
        'totalBytes': total,
        'fonts': fonts,
    }
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
        f.write('\n')
    print(f'{len(fonts)} families, {sum(len(e["files"]) for e in fonts)} files, {total / 1048576:.2f} MB → {out}', file=sys.stderr)
    # catalogue for app/js/fonts.js (JSE_FONTS)
    cat = [{'family': e['family'], 'ko': e['ko'], 'category': e['category'], 'license': e['license'],
            'files': {w: {'file': f['file'], 'bytes': f['bytes']} for w, f in e['files'].items()}} for e in fonts]
    print(json.dumps(cat, ensure_ascii=False))


if __name__ == '__main__':
    main()
