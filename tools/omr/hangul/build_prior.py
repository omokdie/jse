#!/usr/bin/env python3
"""Syllable unigram prior for the Hangul recogniser.

Counts the Hangul syllables of a Korean word list and writes
tools/omr/hangul/syllable_prior.json (counts per syllable). train.py turns it
into a quantised log-prior over the 2,350 KS X 1001 syllables that the JS
decoder adds (weighted) to the visual scores, so that a visually ambiguous
read prefers the common syllable ("천" over "쳔", "세" over "셰").

Default source: the word list of Tesseract's Korean model (tessdata
kor.traineddata, Apache-2.0), extracted with the Tesseract training tools
combine_tessdata + dawg2wordlist when they are installed. Any UTF-8 word or
text list can be used instead with --words.

  python3 tools/omr/hangul/build_prior.py [--words list.txt]
"""
import argparse, collections, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from charset import ks_x_1001_syllables  # noqa: E402

TESSDATA = '/usr/share/tesseract-ocr/5/tessdata/kor.traineddata'


def tesseract_words():
    tmp = tempfile.mkdtemp(prefix='jse-kor-')
    subprocess.run(['combine_tessdata', '-u', TESSDATA, os.path.join(tmp, 'kor.')], check=True, capture_output=True)
    out = os.path.join(tmp, 'words.txt')
    subprocess.run(['dawg2wordlist', os.path.join(tmp, 'kor.lstm-unicharset'), os.path.join(tmp, 'kor.lstm-word-dawg'), out], check=True, capture_output=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--words', default=None, help='UTF-8 word / text list (default: Tesseract kor word list)')
    ap.add_argument('--out', default=os.path.join(HERE, 'syllable_prior.json'))
    args = ap.parse_args()
    src = args.words or tesseract_words()
    ks = set(ks_x_1001_syllables())
    counts = collections.Counter()
    n_words = 0
    with open(src, encoding='utf-8') as f:
        for line in f:
            w = line.strip()
            if not w:
                continue
            n_words += 1
            for ch in w:
                if ch in ks:
                    counts[ch] += 1
    doc = {
        'source': args.words or 'Tesseract 4/5 tessdata kor.traineddata word list (lstm-word-dawg, Apache-2.0)',
        'words': n_words, 'syllables': sum(counts.values()), 'distinct': len(counts),
        'counts': dict(sorted(counts.items(), key=lambda kv: -kv[1])),
    }
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=0)
    print(f'{n_words} words, {doc["syllables"]} syllables, {len(counts)} distinct KS syllables -> {os.path.relpath(args.out)}')


if __name__ == '__main__':
    main()
