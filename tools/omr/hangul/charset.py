"""Class definitions for the JSE Hangul lyric recogniser (shared by the data
generator, the trainer and the JS exporter).

The network has four heads:
  type    : TYPE_CLASSES — 'HANGUL' or one non-Hangul symbol (digits, lyric
            punctuation, basic Latin letters) or 'NOISE' (music fragments,
            partial / merged syllables, specks)
  initial : 19 initial consonants  (choseong)
  medial  : 21 vowels              (jungseong)
  final   : 28 final consonants incl. "none" (jongseong)
A Hangul syllable is decoded as U+AC00 + (i*21 + m)*28 + f, so syllables that
were never rendered during training can still be read.
"""

HANGUL_BASE = 0xAC00
N_INI, N_MED, N_FIN = 19, 21, 28
INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
MEDIALS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
FINALS = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'

DIGITS = list('0123456789')
PUNCT = list(",.!?()~'\":-")
LATIN = [chr(c) for c in range(ord('A'), ord('Z') + 1)] + [chr(c) for c in range(ord('a'), ord('z') + 1)]
SYMBOLS = DIGITS + PUNCT + LATIN
TYPE_CLASSES = ['HANGUL'] + SYMBOLS + ['NOISE']
TYPE_INDEX = {c: i for i, c in enumerate(TYPE_CLASSES)}
HANGUL_T = 0
NOISE_T = TYPE_CLASSES.index('NOISE')

# glyph variants rendered for a symbol class (typographic quotes, fullwidth
# tilde, dashes ... are all read as the plain ASCII class)
SYMBOL_VARIANTS = {
    "'": ["'", '‘', '’'],
    '"': ['"', '“', '”'],
    '~': ['~', '～', '∼'],
    '-': ['-', '–', '‐'],
    '!': ['!', '！'],
    '?': ['?', '？'],
    '(': ['(', '（'],
    ')': [')', '）'],
    ',': [',', '，'],
    ':': [':'],
    '.': ['.'],
}


def ks_x_1001_syllables():
    """The 2,350 modern Hangul syllables of KS X 1001 (EUC-KR two-byte set)."""
    out = []
    for c in range(HANGUL_BASE, 0xD7A4):
        if len(chr(c).encode('euc_kr')) == 2:   # others encode as 8-byte make-up sequences
            out.append(chr(c))
    return out


def decompose(ch):
    code = ord(ch) - HANGUL_BASE
    if not 0 <= code < 11172:
        return None
    return code // 588, (code % 588) // 28, code % 28


def compose(i, m, f):
    return chr(HANGUL_BASE + (i * 21 + m) * 28 + f)


def is_hangul(ch):
    return len(ch) == 1 and 0xAC00 <= ord(ch) <= 0xD7A3
